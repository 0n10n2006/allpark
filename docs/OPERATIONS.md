# ParkShare: Operations Guide & Runbooks

This document covers operational architecture, background job processing, payment gateway configuration, reconciliation procedures, administrative runbooks, backup/restore drills, and incident recovery playbooks for ParkShare.

---

## 1. Background Jobs Architecture

ParkShare uses a durable, database-backed job queue implemented on PostgreSQL (`src/server/jobs/index.ts`). It requires no Redis or external message brokers. All scheduling and lease checks rely exclusively on PostgreSQL's clock (`now()`), making the system immune to clock drift across worker instances.

### 1.1 The `Job` Database Schema

Jobs are persisted in the `Job` table defined in `prisma/schema.prisma`:

| Column | Type | Description |
|---|---|---|
| `id` | `Uuid` (PK) | Unique job identifier (`gen_random_uuid()`). |
| `type` | `String` | Registered job type identifier (e.g. `bookings.expireHolds`). |
| `payload` | `Json` | Input parameters validated with Zod at execution time. |
| `runAt` | `DateTime` (timestamptz) | Timestamp after which the job is due to execute. Default `now()`. |
| `attempts` | `Int` | Number of execution attempts completed (starts at `0`). |
| `maxAttempts` | `Int` | Maximum retry threshold before moving to `DEAD` (default `5`). |
| `lockedAt` | `DateTime?` (timestamptz) | Timestamp when a worker claimed the job lease. |
| `lockedBy` | `String?` | Worker identifier holding the active lease. |
| `lastError` | `String?` | Error message from the most recent failed execution (first 256 chars). |
| `status` | `JobStatus` | Queue state: `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `DEAD`. |
| `idempotencyKey` | `String?` (Unique) | Protects against duplicate job enqueuing. |
| `createdAt` / `updatedAt` | `DateTime` | Audit timestamps. |

**Database Index:** `@@index([status, runAt])` optimizes due job selection.

### 1.2 Registered Job Types

| Job Type | Schedule / Trigger | Purpose & Implementation |
|---|---|---|
| `bookings.expireHolds` | Every 1 minute | Scans `Booking` records in `PENDING_PAYMENT` whose `holdExpiresAt < now()`. Flips status to `EXPIRED` to immediately release inventory. Re-schedules the next 1-minute sweep self-perpetually. |
| `notifications.deliver` | On notification create | Sends transactional and reminder emails via Resend (or `LogSender`). Retries up to 5 times. On final attempt failure, marks `Notification.status = FAILED`. |
| `payments.processRefund` | On refund creation | Dispatches an asynchronous refund request to the Razorpay API (`/payments/:id/refund`) and updates the `Refund` record. |
| `payments.reconcile` | Every 24 hours | Reconciles captured orders and stale refunds older than 30 minutes. Schedulers self-re-queue for the next day. |
| `monthly.renewalReminder` | 7 days before term end | Sends an email/in-app alert to monthly renters prompting them to confirm and pay for the subsequent month. |
| `monthly.expire` | End of term + grace | Expires unrenewed `MonthlyAgreement` rows and frees recurring future inventory if payment was not completed. |
| `monthly.closeTerm` | End of monthly term | Closes completed monthly reservation periods and updates booking lifecycle states. |
| `sessions.startGrace` | Dynamic at `booking.endAt` | Transitions an `ACTIVE` session to `GRACE_PERIOD` when the booked reservation period ends. |
| `sessions.graceExpired` | Dynamic at `endAt + grace` | Transitions a booking from `GRACE_PERIOD` to `OVERSTAY` if the renter has not checked out, and generates an `OverstayIncident`. |
| `system.noop` | Testing only | Side-effect-free job handler used in automated queue test suites. |

### 1.3 Execution Models

ParkShare supports two operational execution models for running jobs:

#### Option A: HTTP Cron Worker (`/api/cron/tick`)
Used in serverless deployments (e.g. Vercel Cron or an external HTTP scheduler).
- **Endpoint:** `POST /api/cron/tick`
- **Authentication:** Protected with a constant-time bearer token check against `CRON_SECRET`:
  ```bash
  # Trigger job batch execution:
  curl -X POST https://parkshare.example.com/api/cron/tick \
    -H "Authorization: Bearer <CRON_SECRET>"
  ```
  *Status in this worktree: Executed successfully via automated integration test `tests/jobs/tick.test.ts`.*
- **Execution Budget:** The handler loops `runOnce()` until the queue is drained or a 25-second deadline is reached (ensuring safe completion before standard 30-second serverless execution timeouts).
- **Response Format:**
  ```json
  { "claimed": 4, "succeeded": 4, "retried": 0, "dead": 0 }
  ```

#### Option B: Dedicated Node Worker (`npm run worker`)
Used in containerized or VM environments (e.g. Docker, Railway, AWS ECS, Render).
- **Execution:**
  ```bash
  npm run worker
  ```
  *Status in this worktree: Script tested and verified.*
- **Behavior:** Polls the database queue every 5 seconds (`setTimeout 5000ms`), claims up to 10 due jobs per batch, and outputs structured JSON logs:
  ```json
  {"event":"jobs.tick","workerId":"worker:12345:8f9a2b...","claimed":0,"succeeded":0,"retried":0,"dead":0}
  ```

### 1.4 Concurrency, Leases, Retry, and Dead-Lettering

1. **Atomic Lease Claiming:**
   Workers claim due jobs using `SELECT ... FOR UPDATE SKIP LOCKED`:
   ```sql
   UPDATE "Job"
   SET status = 'RUNNING', "lockedAt" = now(), "lockedBy" = $workerId, "updatedAt" = now()
   WHERE status = 'PENDING' AND id IN (
     SELECT id FROM "Job"
     WHERE status = 'PENDING' AND "runAt" <= now()
     ORDER BY "runAt"
     FOR UPDATE SKIP LOCKED
     LIMIT 10
   )
   RETURNING *;
   ```
2. **Expired Lease Reclamation:**
   Default lease duration is 5 minutes (`300 seconds`). If a worker process terminates abruptly or crashes mid-job, subsequent workers reclaim expired leases:
   ```sql
   UPDATE "Job"
   SET attempts = attempts + 1,
       "lastError" = 'Lease expired (worker crashed or timed out)',
       status = CASE WHEN attempts + 1 >= "maxAttempts" THEN 'DEAD'::"JobStatus" ELSE 'PENDING'::"JobStatus" END,
       "lockedAt" = NULL, "lockedBy" = NULL, "updatedAt" = now()
   WHERE status = 'RUNNING'
     AND "lockedAt" < now() - (300 * interval '1 second');
   ```
3. **Exponential Backoff:**
   When a handler throws an error, the job is rescheduled with exponential backoff:
   $$\text{delay} = \min(3600, 30 \times 2^{\text{attempts}}) \text{ seconds}$$
   - Attempt 1 failure: retry in 30s
   - Attempt 2 failure: retry in 60s
   - Attempt 3 failure: retry in 120s
   - Attempt 4 failure: retry in 240s
   - Attempt 5: marks status `DEAD`
4. **Permanent Failures:**
   If a job payload fails Zod schema validation or its job type is unregistered, it immediately transitions to `DEAD` without wasting retries.

### 1.5 Admin Runbook: Dead Job Investigation & Manual Retry

To inspect and re-run dead jobs:

1. **List Dead Jobs via Admin API:**
   ```bash
   # Query dead jobs:
   curl -X GET "https://parkshare.example.com/api/admin/jobs?jobStatus=DEAD" \
     -H "Cookie: next-auth.session-token=<ADMIN_TOKEN>"
   ```
2. **Inspect Failure Cause:**
   Examine `lastError` and `payload` to determine whether the failure was environmental (e.g. provider downtime) or data corruption.
3. **Retry Dead Jobs via Database:**
   Once the underlying issue is resolved, reset the job status in PostgreSQL to re-enqueue it immediately:
   ```sql
   -- Reset a specific dead job for immediate re-execution:
   UPDATE "Job"
   SET status = 'PENDING',
       attempts = 0,
       "runAt" = now(),
       "lastError" = NULL,
       "lockedAt" = NULL,
       "lockedBy" = NULL
   WHERE id = '<JOB_UUID>' AND status = 'DEAD';
   ```

---

## 2. Razorpay Payment Gateway Configuration

ParkShare integrates with Razorpay for order creation, customer checkout, webhook settlement, and refunds.

### 2.1 API Keys & Credentials

Configure the following environment variables:
- `RAZORPAY_KEY_ID`: Server-side API key (starts with `rzp_test_` or `rzp_live_`).
- `RAZORPAY_KEY_SECRET`: Server-side API secret key.
- `NEXT_PUBLIC_RAZORPAY_KEY_ID`: Client-side key for initializing Razorpay Checkout in the browser.
- `RAZORPAY_WEBHOOK_SECRET`: Secret token used to compute and verify webhook HMAC signatures.

### 2.2 Webhook Configuration in Razorpay Dashboard

1. Log in to the [Razorpay Dashboard](https://dashboard.razorpay.com/) (select **Test Mode** for staging or **Live Mode** for production).
2. Navigate to **Settings** → **Webhooks** → **Add New Webhook**.
3. **Webhook URL:** `https://<YOUR_DOMAIN>/api/webhooks/razorpay`
4. **Secret:** Paste the value matching your `RAZORPAY_WEBHOOK_SECRET`.
5. **Alert Email:** Add your operations alert distribution list.
6. **Active Events to Subscribe (Mandatory 5 Events):**
   - `payment.captured`: Triggers booking settlement and confirmation when payment succeeds.
   - `payment.failed`: Records payment failure reason and closes unfulfilled checkout sessions.
   - `order.paid`: Redundant signal ensuring order confirmation even if payment event is delayed.
   - `refund.processed`: Marks internal `Refund` row as `PROCESSED` and records provider refund ID.
   - `refund.failed`: Marks internal `Refund` row as `FAILED` and raises an alert.

### 2.3 Webhook Verification & Idempotency Safeguards

- **HMAC Signature Check:** ParkShare reads the raw HTTP request body and verifies the `x-razorpay-signature` header using `crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)`. If the signature does not match, the route returns HTTP `400 Invalid signature` and discards the payload without writing to the database.
- **Deduplication:** Every event is written to the `ProviderEvent` table using an atomic `INSERT ... ON CONFLICT (provider, "eventId") DO NOTHING`. Duplicate deliveries return HTTP `200 {"received": true}` immediately without re-executing transactions.
- **Automatic Retries:** If internal database errors occur during settlement, the endpoint returns HTTP `500`, causing Razorpay to automatically retry webhook delivery with exponential backoff over 24 hours.

---

## 3. Financial Reconciliation

### 3.1 Daily Automated Reconciliation (`payments.reconcile`)

The background job `payments.reconcile` runs daily (and can be invoked on demand by administrators via `reconcilePayments()` and `reconcileRefunds()`):

1. **Unsettled Orders Check:**
   - Evaluates `Payment` rows created more than 30 minutes ago that remain in `PENDING` or `PROCESSING`.
   - Calls Razorpay API `fetchOrderPayments(providerOrderId)`.
   - **Resolution A (Captured at Provider):** If Razorpay reports `captured` but ParkShare never received the webhook, ParkShare settles the payment immediately, marks the booking `CONFIRMED`, creates an audit log entry (`action: payment.reconciled`, `reason: captured_unsettled`), and logs a warning.
   - **Resolution B (Unpaid & Hold Expired):** If Razorpay reports no successful payment and the inventory hold has expired, the payment is marked `FAILED` with reason `reconciled_unpaid`, and `reconciledAt` is stamped.
2. **Stale Refunds Check:**
   - Evaluates `Refund` rows in `PENDING` or `PROCESSING` older than 30 minutes.
   - Calls Razorpay API `fetchRefund(paymentId, refundId)`.
   - Syncs provider outcome (`processed` or `failed`) and stamps `reconciledAt`.

### 3.2 Host Payout Reconciliation Dashboard

Administrators can inspect financial balance integrity at `GET /api/admin/payouts/reconciliation`:
- **Calculated Host Balance:**
  $$\text{Outstanding} = \text{Host Earnings} - \text{Host-borne Refunds} - \text{Host Payouts}$$
- **Discrepancy Checks:**
  1. Compares outstanding ledger balance with un-paid completed bookings.
  2. Verifies that every `PAID` `HostPayout` has corresponding `HOST_PAYOUT` ledger entries matching the exact amount and provider reference.
  3. Any discrepancy is flagged in the response array `discrepancies` with `kind: payout_ledger_mismatch`.

---

## 4. Runbook: Manual Host Payouts (`payoutMode = MANUAL`)

As specified in PRD §6 and the Implementation Plan, host payouts operate in `MANUAL` mode by default until provider marketplace integration (Razorpay Route) is finalized.

### Step-by-Step Payout Workflow

1. **Review Payable Earnings:**
   Navigate to the Admin Console under Payouts or query:
   ```bash
   GET /api/admin/payouts/reconciliation
   ```
   A booking is eligible for payout only when:
   - `status = 'COMPLETED'`
   - `hostPayoutId IS NULL` (not already claimed)
   - `payoutHoldbackHours` (default 24 hours) have elapsed since checkout (allows dispute filing).
2. **Create Payout Batch:**
   Send a request to create a payout claim for a host:
   ```bash
   POST /api/admin/payouts
   Headers:
     Idempotency-Key: <UUID>
     Content-Type: application/json
   Body:
     {
       "hostId": "<HOST_UUID>",
       "bookingIds": ["<BOOKING_UUID_1>", "<BOOKING_UUID_2>"],
       "reason": "Weekly scheduled payout batch"
     }
   ```
   *The system locks the requested bookings in ID order, validates payable status, creates a `HostPayout` row with status `PENDING`, and sets `booking.hostPayoutId`.*
3. **Execute Bank Transfer:**
   The finance operator logs into the company corporate banking portal and initiates an IMPS/NEFT/UPI transfer to the host's verified bank account for the exact `amountPaise`. Note the transaction UTR / bank reference number.
4. **Mark Payout Paid:**
   Record the banking reference to complete the payout:
   ```bash
   POST /api/admin/payouts/<PAYOUT_UUID>/mark-paid
   Body:
     {
       "providerReference": "UTR98234710293",
       "reason": "HDFC IMPS transfer completed"
     }
   ```
   *This updates payout status to `PAID`, stamps `paidAt`, creates a `HOST_PAYOUT` `LedgerEntry`, and creates an immutable `AuditLog` entry.*
5. **Handling Failed Bank Transfers:**
   If a bank transfer fails, bounces, or is rejected:
   ```bash
   POST /api/admin/payouts/<PAYOUT_UUID>/mark-failed
   Body:
     {
       "reason": "Beneficiary account frozen; bank returned R03"
     }
   ```
   *This updates payout status to `FAILED`, atomically clears `hostPayoutId = NULL` across all claimed bookings (releasing them for future payout attempts), and notifies the host and all platform administrators.*

---

## 5. Runbook: Refunds & Disputes

### 5.1 Dispute Lifecycle

1. **Dispute Ingestion:**
   A renter or host files a dispute via `POST /api/disputes` with a mandatory `category` (`ACCESS_ISSUE`, `VEHICLE_DAMAGE`, `SPACE_MISREPRESENTED`, `OVERSTAY_UNRESOLVED`, `OTHER`), description, and uploaded evidence URLs.
   - If the booking is currently in session (`ACTIVE`, `GRACE_PERIOD`, `OVERSTAY`), its status transitions to `DISPUTED`.
2. **Support Investigation:**
   Support reviews the dispute in the Admin Console (`GET /api/admin/disputes/:id`). The view surfaces:
   - Complete booking history and timestamps.
   - All payment attempts and existing refunds.
   - Renter and host messaging/incident logs.
   - Audit trail of all state transitions.
3. **Resolution Action:**
   Admins resolve disputes via `POST /api/admin/disputes/:id/resolve`:
   ```bash
   POST /api/admin/disputes/<DISPUTE_UUID>/resolve
   Body:
     {
       "outcome": "RESOLVED",
       "resolution": "Host gate was locked; full refund issued to renter",
       "reason": "Host uncontactable during booked window",
       "bookingOutcome": "CANCELLED",
       "refundPaise": 50000
     }
   ```
   - **Financial Invariant:** Resolving a dispute **never** charges or penalizes either party automatically.
   - If `refundPaise` is specified, the system creates a `Refund` record and enqueues a `payments.processRefund` job.
   - If the booking was in `DISPUTED`, `bookingOutcome` (`COMPLETED` or `CANCELLED`) moves the booking out of the disputed state.

---

## 6. Runbook: Monthly Renewals & Term Closing

1. **Agreement Lifecycle:**
   Monthly parking operates as a continuous agreement (`MonthlyAgreement`) where each paid month is an individual `Booking` with `rentalType = MONTHLY`.
2. **Advance Notice (7 Days):**
   7 days before the active term ends, the `monthly.renewalReminder` job dispatches an email and in-app prompt alerting the renter that renewal is open.
3. **Manual Renewal:**
   The renter confirms renewal at `POST /api/monthly/:id/renew`. This creates a subsequent monthly booking row claiming the future 30-day block, preventing short-term bookings from fragmenting the space.
4. **Unpaid Term Expiration:**
   If the renter does not complete payment before the term expires plus grace (`unpaidGraceDays`, default 0), `monthly.expire` marks the agreement `EXPIRED` and frees future calendar dates.
5. **Term Closing:**
   When the month concludes, `monthly.closeTerm` transitions the booking from `ACTIVE` to `COMPLETED`.

---

## 7. Runbook: Overstay Incident Handling

- **Zero Undisclosed Penalties:** Per PRD §5 and §10, `overstayFeeEnabled` is set to `false`. ParkShare **never** charges automatic fines or surprise fees to user credit cards or bank accounts.
- **Automated Grace & Overstay State:**
  1. When a booking reaches its scheduled `endAt`, `sessions.startGrace` moves status to `GRACE_PERIOD`.
  2. If the renter does not check out within `gracePeriodMinutes` (default 10 min), `sessions.graceExpired` moves status to `OVERSTAY` and opens an `OverstayIncident`.
- **Host Incident Reporting:**
  If another vehicle is blocked or the renter has not departed, the host can submit photos via `POST /api/bookings/:id/incidents`.
- **Support Resolution:**
  Support contacts the renter and host. Once the vehicle departs, support resolves the incident via `resolveIncident(adminId, incidentId, resolution, reason)`:
  - Incident status becomes `RESOLVED`.
  - The booking status transitions from `OVERSTAY` to `COMPLETED`.
  - Audited with the admin's reason.

---

## 8. Notifications Operations

### 8.1 Configuration & Providers

ParkShare uses Resend for transactional emails:
- `RESEND_API_KEY`: API token from Resend.
- `EMAIL_FROM`: Verified sender address (e.g. `ParkShare <noreply@parkshare.in>`).

### 8.2 Fallback: `LogSender`

If `RESEND_API_KEY` is empty (as in development and test environments), `getEmailSender()` automatically falls back to `LogSender`:
- Outputs JSON logs: `{"event":"email.log","type":"BOOKING_CONFIRMED","notificationId":"..."}`.
- **Privacy Rule (PRD §9):** `LogSender` **never** outputs recipient email addresses, user names, or message contents into system logs.

### 8.3 Retries on Delivery Failures

The `notifications.deliver` job retries failed email dispatches with exponential backoff up to 5 times. If Resend is unavailable or returns an error, the job retries. Upon exhausting all 5 attempts, `Notification.status` is marked `FAILED` and `lastError` is recorded.

---

## 9. Backup & Disaster Recovery

### 9.1 PostgreSQL Backup Procedure (`pg_dump`)

Generate consistent binary backups of the PostgreSQL database using custom archive format (`-Fc`), which supports parallel restore and compression:

```bash
# Production backup command (PostgreSQL 16):
pg_dump --format=custom \
        --no-owner \
        --no-privileges \
        --dbname="$DATABASE_URL" \
        --file="parkshare_backup_$(date +%Y%m%d_%H%M%S).dump"
```
*Note: Not executed in production; marked "not executed". Tested syntax against PostgreSQL 16.*

### 9.2 Restore Procedure (`pg_restore`)

```bash
# Restore backup into target database:
pg_restore --clean \
           --if-exists \
           --no-owner \
           --no-privileges \
           --dbname="$TARGET_DATABASE_URL" \
           "parkshare_backup_<TIMESTAMP>.dump"
```
*Note: Not executed in production; marked "not executed".*

### 9.3 Restore Drill Procedure (Quarterly Operational Drill)

To verify backup validity and test database integrity:

1. **Provision Drill Database:** Create an isolated database `parkshare_restore_drill`.
2. **Execute Restore:** Run `pg_restore` from the latest backup file into `parkshare_restore_drill`.
3. **Verify Extensions:** Connect with `psql` and confirm `btree_gist` is present:
   ```sql
   SELECT extname, extversion FROM pg_extension WHERE extname = 'btree_gist';
   ```
4. **Verify Exclusion Constraints:** Verify that the booking exclusion constraint `booking_no_overlap` is functional:
   ```sql
   SELECT conname, contype FROM pg_constraint WHERE conname = 'booking_no_overlap';
   ```
5. **Verify Row Counts:** Query `User`, `Listing`, `Booking`, `Payment`, and `PolicyVersion` counts against production statistics.
6. **Execute Migration Status Check:** Run `npx prisma migrate status` to confirm schema alignment.
7. **Tear Down Drill DB:** Drop `parkshare_restore_drill`.

---

## 10. Monitoring & Alerting Checklist

Monitor the following key signals across logs, database queries, and admin dashboard metrics:

| Metric / Signal | Threshold / Condition | Recommended Alert Priority | Action |
|---|---|---|---|
| Dead Job Count | `deadJobsCount > 0` (from `/api/admin/stats` or `Job` status `DEAD`) | **P1 - High** | Inspect `lastError` in `Job` table; run Dead Job Runbook (§1.5). |
| Unsettled Payments | Captured at Razorpay but unconfirmed after 35 min | **P2 - Medium** | Trigger `payments.reconcile`; inspect webhook delivery logs. |
| Webhook Failure Rate | HTTP 5xx responses on `/api/webhooks/razorpay` > 1% | **P1 - High** | Check database connection pool exhaustion or unhandled event payloads. |
| Stale Inventory Holds | `Booking` in `PENDING_PAYMENT` with `holdExpiresAt < now() - 5m` | **P2 - Medium** | Check if `bookings.expireHolds` sweeper job is stalling. |
| Exclusion Constraint Violations | Postgres error code `23P01` in application logs | **P3 - Low** | Normal under high concurrency (handled as HTTP 409 conflict); investigate if rate spikes. |
| Payout Ledger Discrepancies | `discrepancies.length > 0` on `/api/admin/payouts/reconciliation` | **P1 - High** | Freeze manual payouts; inspect recent manual payouts or late refunds. |

---

## 11. Incident Recovery Playbooks

### Playbook A: Razorpay Webhook Delivery Outage
- **Symptoms:** Renters report payments succeeded on their bank screens, but bookings remain in `PENDING_PAYMENT`.
- **Root Cause:** Razorpay webhook service degradation or internet transit outage between Razorpay and ParkShare.
- **Resolution:**
  1. Trigger immediate payment reconciliation:
     ```bash
     # Execute reconciliation via node CLI or trigger payments.reconcile job:
     node --env-file=.env --import tsx -e 'import("@/server/payments/service").then(m => m.reconcilePayments()).then(console.log)'
     ```
  2. The reconciliation logic polls `fetchOrderPayments()` for all stale open orders, detects the captured funds, settles the payment, and confirms the bookings.
  3. Inform affected users that their parking reservations are confirmed.

### Playbook B: Stuck Inventory Holds
- **Symptoms:** Search results show spaces unavailable even though no confirmed bookings exist.
- **Root Cause:** Hold expiration sweeper missed ticks or worker process was terminated.
- **Resolution:**
  1. Run the hold sweep manually:
     ```bash
     node --env-file=.env --import tsx -e 'import("@/server/availability/service").then(m => m.expireStaleHolds()).then(console.log)'
     ```
  2. Check `Job` table for `type = 'bookings.expireHolds'` to confirm future sweeps are queued.

### Playbook C: Third-Party Provider Downtime
- **Resend Outage:**
  - In-app notifications continue working unaffected.
  - Outgoing emails fail, and `notifications.deliver` jobs automatically back off up to 5 times.
  - Temporarily unset `RESEND_API_KEY` to switch into `LogSender` mode if provider downtime extends beyond 24 hours.
- **Cloudinary Outage:**
  - Photo upload signing (`/api/listings/:id/photos/sign`) returns HTTP 503 Service Unavailable with friendly user messages.
  - Existing listings and cached image URLs continue serving normally.
- **Mapbox Outage:**
  - Coordinate search and distance sorting continue working server-side (ParkShare uses pure PostgreSQL Haversine math for geospatial queries).
  - Web map renders a graceful offline fallback tile message.
