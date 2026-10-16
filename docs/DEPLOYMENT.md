# ParkShare: Production Deployment Guide

> [!IMPORTANT]
> **Deployment Status:** As of October 2026, **nothing has been deployed**. ParkShare has been tested locally and verified against automated integration test suites. This document provides the authoritative deployment runbook, infrastructure requirements, and pre-launch checklists for production rollout.

---

## 1. Hosting Architecture: Vercel & Managed PostgreSQL

ParkShare is designed to deploy on **Vercel** (Next.js App Router with Server-Side Rendering) coupled with a **managed PostgreSQL 16+** database.

### 1.1 Managed PostgreSQL Requirements (`btree_gist`)

ParkShare relies on a PostgreSQL exclusion constraint (`booking_no_overlap`) to guarantee that overlapping reservations can never be confirmed for the same parking space under any concurrency level.

- **Mandatory Extension:** The managed database provider **must support the `btree_gist` extension**.
- **Supported Providers:**
  - **Neon Serverless Postgres:** Supports `btree_gist` out of the box. Compatible with Vercel connection pooling (`?sslmode=require`).
  - **Supabase PostgreSQL:** Supports `btree_gist`.
  - **AWS RDS / Aurora PostgreSQL:** Supports `btree_gist` (add to parameter group or execute `CREATE EXTENSION`).
  - **Google Cloud SQL for PostgreSQL:** Supports `btree_gist`.
  - **Azure Database for PostgreSQL:** Supports `btree_gist`.
- **Extension Verification Command:**
  Before deploying migrations, verify or enable the extension on the production database:
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ```
  *Note: Not executed against production cloud; marked "not executed". Verified locally in PostgreSQL 16.*

---

## 2. Background Scheduler Options for `/api/cron/tick`

The endpoint `POST /api/cron/tick` drives background jobs, hold expiration, session grace period transitions, and daily payment reconciliation. The scheduler must invoke this endpoint regularly with header:
```http
Authorization: Bearer <CRON_SECRET>
```

Selecting the scheduler is an **open decision** before launch. The trade-offs of both options are presented below:

### Option 1: Vercel Cron
Configure `vercel.json` in the project root:
```json
{
  "crons": [
    {
      "path": "/api/cron/tick",
      "schedule": "* * * * *"
    }
  ]
}
```
- **Pros:** Native to the Vercel deployment pipeline; requires no external services or extra credentials; automatic deployment with Git.
- **Cons & Constraints:**
  - Vercel **Hobby plans** restrict crons to once per day (incompatible with the 1-minute hold expiration sweeper).
  - Vercel **Pro plans** allow 1-minute cadence (`* * * * *`), but maximum serverless function execution timeout applies (default 15s, configurable up to 60s or 300s).

### Option 2: External HTTP Scheduler (Upstash QStash, Cloudflare Workers, or AWS EventBridge)
Configure an external scheduler to send an HTTP POST request to `https://<YOUR_DOMAIN>/api/cron/tick` every 60 seconds with `Authorization: Bearer <CRON_SECRET>`.
- **Pros:** Completely decoupled from Vercel plan limits; provides independent execution metrics, failure alerts, and automatic retries; works identically across staging and production environments.
- **Cons:** Introduces another cloud service dependency and dashboard to manage.

---

## 3. Environment Variables Specification

The table below reflects **every environment variable** validated in `src/lib/env.ts`.

| Variable | Type | Required? | Default / Example | Purpose & Where Used |
|---|---|---|---|---|
| `DATABASE_URL` | URL | **Required** | `postgresql://user:pass@host:5432/parkshare?sslmode=require` | Primary PostgreSQL connection string used by Prisma client and migrations. |
| `TEST_DATABASE_URL` | URL | Optional | `postgresql://user:pass@host:5432/parkshare_test` | Dedicated database for Vitest integration tests. |
| `AUTH_SECRET` | String | **Required** | `openssl rand -hex 32` | Encryption secret for NextAuth.js (Auth.js v5) session cookies and JWTs. |
| `AUTH_URL` | URL | **Required** | `https://parkshare.in` | Canonical base URL used by NextAuth and CSRF origin verification on mutations. |
| `EMAIL_FROM` | String | **Required** | `ParkShare <noreply@parkshare.in>` | Outbound sender address for transactional emails. |
| `RESEND_API_KEY` | String | Optional (Provider) | `re_...` | Resend API key for outbound transactional emails. Falls back to `LogSender` if omitted. |
| `RAZORPAY_KEY_ID` | String | Optional (Provider) | `rzp_live_...` | Server-side Razorpay Key ID for creating orders and querying payment status. |
| `RAZORPAY_KEY_SECRET` | String | Optional (Provider) | `...` | Server-side Razorpay Key Secret. |
| `RAZORPAY_WEBHOOK_SECRET` | String | Optional (Provider) | `...` | Secret key for verifying HMAC-SHA256 signatures on incoming Razorpay webhooks. |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | String | Optional (Provider) | `rzp_live_...` | Public client-side key for initializing Razorpay Checkout modal in browser. |
| `CLOUDINARY_CLOUD_NAME` | String | Optional (Provider) | `parkshare` | Cloudinary account name for storing listing photos and dispute evidence. |
| `CLOUDINARY_API_KEY` | String | Optional (Provider) | `...` | Cloudinary API Key for generating HMAC upload signatures. |
| `CLOUDINARY_API_SECRET` | String | Optional (Provider) | `...` | Cloudinary API Secret for signing direct browser uploads. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | String | Optional (Provider) | `pk.eyJ...` | Public Mapbox GL token for interactive maps and location autocomplete. |
| `CRON_SECRET` | String | **Required** | `openssl rand -hex 32` | Shared secret protecting `POST /api/cron/tick` from unauthorized calls. |
| `APP_TIMEZONE` | String | Optional | `Asia/Kolkata` | Application timezone for localized dates and input display (default: `Asia/Kolkata`). |

### Codebase Environment Variables Mismatch Analysis

During codebase audit, the following variables were found in scripts and test configurations but are intentionally omitted from `src/lib/env.ts`:
1. `E2E_PORT`: Used exclusively by `scripts/setup-worktree.mjs` and `playwright.config.ts` to dynamically assign isolated ports (range 3100-3899) during parallel local development. Not required in production runtime.
2. `RAZORPAY_API_URL`: Used exclusively in `playwright.config.ts` to redirect E2E test runs to an ephemeral local mock Razorpay HTTP server. In production, Razorpay SDK defaults to official upstream endpoints.
3. `PARKSHARE_PG_ADMIN_URL`: Read exclusively by `scripts/setup-worktree.mjs` to provision developer test databases. Not required in production runtime.

---

## 4. Database Migration Process (`prisma migrate deploy`)

In production, database migrations **must only be applied via `prisma migrate deploy`**. Never run `prisma migrate dev` or `prisma db push` in production.

### 4.1 CI/CD Migration Execution

In your CI/CD pipeline (e.g. GitHub Actions or Vercel Build Step), run:
```bash
# 1. Generate Prisma client:
npx prisma generate

# 2. Apply pending versioned SQL migrations:
npx prisma migrate deploy
```
*Status: Executed successfully in this worktree during setup (`npx prisma migrate status` confirmed schema up to date).*

### 4.2 Zero-Downtime Migration Guidelines

Because ParkShare operates continuous booking and payments:
- **Expand-Contract:** Schema changes must be backward-compatible. Add new columns as optional or with default values; deploy code that populates them; remove old columns in subsequent releases.
- **Exclusion Constraints:** Modifying the `booking_no_overlap` constraint locks the `Booking` table. Schedule any constraint changes during off-peak maintenance windows.

---

## 5. Third-Party Provider Production Setup

### 5.1 Razorpay Webhooks in Production
1. In the Razorpay Live Dashboard, create a webhook targeting:
   `https://<YOUR_PRODUCTION_DOMAIN>/api/webhooks/razorpay`
2. Enter your production `RAZORPAY_WEBHOOK_SECRET`.
3. Subscribe to the 5 mandatory events:
   - `payment.captured`
   - `payment.failed`
   - `order.paid`
   - `refund.processed`
   - `refund.failed`

### 5.2 Cloudinary Signed Uploads
ParkShare implements direct-from-browser uploads to avoid routing large photo files through serverless compute limits:
1. In Cloudinary Console, note your **Cloud Name**, **API Key**, and **API Secret**.
2. ParkShare signs upload parameters server-side (`src/server/media/photos.ts` and `src/server/media/evidence.ts`).
3. Strict folder isolation is enforced:
   - Listing photos: `listings/<listingId>/*`
   - Dispute & overstay evidence: `evidence/<bookingId>/*`

### 5.3 Mapbox
1. In your [Mapbox Account](https://account.mapbox.com/), create an access token.
2. Restrict token URL origin to your production domain (`https://parkshare.in/*`).
3. Set `NEXT_PUBLIC_MAPBOX_TOKEN`.

### 5.4 Resend (Transactional Email)
1. Add and verify your sending domain (e.g. `mail.parkshare.in`) in Resend.
2. Configure DNS records: SPF, DKIM, and DMARC.
3. Configure `RESEND_API_KEY` and set `EMAIL_FROM="ParkShare <noreply@mail.parkshare.in>"`.

---

## 6. Security Headers & Network Hardening

Next.js is configured with strict security headers:
- **HSTS:** `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- **Clickjacking Protection:** `X-Frame-Options: DENY`
- **MIME Sniffing Prevention:** `X-Content-Type-Options: nosniff`
- **Referrer Policy:** `Referrer-Policy: strict-origin-when-cross-origin`
- **CSRF & Origin Guarding:** All mutating endpoints (`POST`, `PATCH`, `DELETE`) pass through `src/server/http/route.ts`, which validates that the HTTP `Origin` header matches `AUTH_URL`.

---

## 7. Pre-Launch Checklist (PRD §11 Launch Gates)

Before opening ParkShare to public users in Pune, verify and sign off on each launch gate:

- [ ] **Gate 1: Payment Provider & Payout Arrangements:**
  - Razorpay live merchant account activated with KYC approved.
  - Manual payout workflow tested and approved with finance operations.
- [ ] **Gate 2: Concurrency & Webhook Idempotency:**
  - Automated tests pass: `tests/booking/concurrency.test.ts` (proves 20 parallel requests on 1 slot results in exactly 1 confirmation and 19 409 conflicts).
  - Webhook deduplication tests pass: `tests/payments/webhook.test.ts`.
- [ ] **Gate 3: Transparent Pricing & Terms Disclosure:**
  - Hourly, daily, multi-day, weekly, and monthly rates clearly displayed.
  - Cancellation tiers and refund percentages visible on checkout modal.
  - Grace period (10 minutes) disclosed; zero surprise overstay fees confirmed.
- [ ] **Gate 4: Host Verification & Listing Moderation:**
  - Admin review interface verified for host identity and property documentation.
  - Listing moderation and suspension endpoints operational (`POST /api/admin/listings/:id/suspend`).
- [ ] **Gate 5: Operational Support Escalation:**
  - Support staff trained on dispute review (`/api/admin/disputes`) and overstay incident resolution.
  - Emergency contact procedure established for blocked access incidents.
- [ ] **Gate 6: Legal & Policy Compliance:**
  - Privacy policy and terms of service reviewed and published.
  - Tax treatment for parking transactions and marketplace commissions confirmed.
- [ ] **Gate 7: Operational Readiness:**
  - Database backup script verified with restore drill (`docs/OPERATIONS.md §9`).
  - Scheduled cron `/api/cron/tick` verified running at 1-minute intervals.
  - Daily financial reconciliation tested and verified.
