# ParkShare Local Demo Mode Walkthrough

ParkShare includes a **zero-configuration local demo mode** that allows anyone (owners, stakeholders, designers, engineers) to run and click through the entire product on their local workstation without setting up external third-party services (no Razorpay account, no Cloudinary cloud, no Mapbox access token, and no Resend API key).

Demo mode is strictly isolated to non-production environments (`DEMO_MODE=1` and `NODE_ENV !== "production"`). Any attempt to activate demo mode in production throws an immediate boot-time error.

---

## 1. Prerequisites

1. **Node.js:** Node.js `24.x` (LTS) and `npm 10+`.
2. **PostgreSQL:** PostgreSQL `16.x` server running with the `btree_gist` extension enabled:
   ```sql
   CREATE EXTENSION IF NOT EXISTS btree_gist;
   ```
3. **Admin Connection URL File:**
   ParkShare uses an automated worktree provisioner to create isolated databases. Provide your PostgreSQL admin connection URL:
   - **Windows (PowerShell):**
     ```powershell
     mkdir -p "$HOME\.parkshare"
     Set-Content -Path "$HOME\.parkshare\pg-admin-url" -Value "postgresql://postgres:postgres@localhost:5432/postgres"
     ```
   - **Linux / macOS:**
     ```bash
     mkdir -p ~/.parkshare
     echo "postgresql://postgres:postgres@localhost:5432/postgres" > ~/.parkshare/pg-admin-url
     ```

---

## 2. Quick Setup & Launch

Run the worktree setup command (or initialize your environment):

```bash
npm run setup:worktree -- demo
```

Then start demo mode with a single command:

```bash
npm run demo
```

### What `npm run demo` does:
1. Sets `DEMO_MODE=1` and `NEXT_PUBLIC_DEMO_MODE=1`.
2. Runs database migrations (`prisma migrate deploy`).
3. Seeds rich demo data (`npm run db:seed:demo`) including the 4 demo personas, ~30 Pune listings by Harsh with local placeholder photos, bookings in every interesting state, an active monthly agreement, open dispute, report, completed payout bookings, and notifications.
4. Concurrently starts the Next.js development server (`next dev`) and the background job processor worker (`src/server/jobs/worker-cli.ts`).
5. Displays quick sign-in URLs and seeded credentials.

Open your browser at:
- **Web App:** [http://localhost:3000](http://localhost:3000)
- **Demo Quick Sign-In:** [http://localhost:3000/dev/sign-in](http://localhost:3000/dev/sign-in)

---

## 3. Seeded Demo Personas

On [http://localhost:3000/dev/sign-in](http://localhost:3000/dev/sign-in), click **"Sign in as ..."** to immediately establish an authenticated session as any of the following accounts:

| Persona | Name | Email | Roles | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Renter** | Riya Sen | `riya@parkshare.local` | `RENTER` | Primary renter with multiple bookings, active sessions, vehicles, and unread notifications. |
| **Verified Host** | Harsh Vardhan | `harsh@parkshare.local` | `HOST`, `RENTER` | Host of ~30 Pune parking locations, manages availability rules, tracks earnings, requests payouts. |
| **New Host** | Naveen Host | `newhost@parkshare.local` | `HOST`, `RENTER` | Newly registered host with pending verification (`PENDING`), owns draft listings. |
| **Admin** | Asha Sharma | `asha@parkshare.local` | `ADMIN`, `RENTER` | Back-office admin: reviews hosts, moderates listings, resolves disputes, processes payouts. |

---

## 4. Guided Role-Based Walkthroughs

### Tour 1: The Renter Journey (`riya@parkshare.local`)
1. **Sign In:** Go to `/dev/sign-in` and click **"Sign in as Riya"**.
2. **Explore:** Navigate to `/explore`. Search across Pune localities (e.g., *Koregaon Park*, *Baner*, *Kothrud*). Filter by vehicle type (Hatchback, SUV, Sedan) and space type.
3. **Book a Space:** Select any listing (e.g., *Society stilt parking near Koregaon Park*). Choose dates/times and click **Reserve**.
4. **Simulated Payment:**
   - On the checkout page, review the price quote.
   - The payment section displays the clearly labelled **"Simulated payment (demo mode, no real money)"** panel.
   - Click **"Pay ₹X (Simulate Success)"**.
   - The payment is signed using the internal demo secret and posts to `/api/bookings/:id/confirm-payment`. The standard settlement engine (`settlePayment` / `settleTx`) processes the payment, creates double-entry ledger rows, and sets booking status to `CONFIRMED`.
   - *(Optional: Click **"Simulate failure"** to see payment rejection and retry options).*
5. **View Booking & Access Details:**
   - Go to `/bookings` or click into your new confirmed booking. Notice that full access instructions and gate codes are revealed once confirmed.
6. **Active Session & Check-in:**
   - View Riya's pre-seeded **ACTIVE** booking. Notice the live parking timer.
7. **Extension:**
   - In the active session, click **"Extend booking"**.
   - Choose additional hours. The simulated payment panel appears for the extension quote. Click pay to extend the end time.
8. **Check-out & Review:**
   - Click **"Check out"** to complete the session.
   - Navigate to Riya's pre-seeded **COMPLETED** booking and click **"Write a review"** to submit a rating and comment.
9. **Monthly Agreement:**
   - Navigate to `/bookings` to inspect Riya's **ACTIVE** monthly agreement with 5 days remaining before renewal.

---

### Tour 2: The Host Journey (`harsh@parkshare.local`)
1. **Sign In:** Go to `/dev/sign-in` and click **"Sign in as Harsh"**.
2. **List a New Space:**
   - Navigate to `/host/listings/new`.
   - Fill in space details (Title, Address in Pune, Vehicle types, Space type).
   - **Local Photo Upload:** Upload any JPG, PNG, or WebP image. In demo mode, photos upload directly to the local `/api/dev/uploads` endpoint, undergo magic-byte sniffing and size verification (≤ 8 MB), and store under `public/uploads/` with zero third-party Cloudinary calls.
   - Set hourly, daily, and monthly rates, agree to host rules, and publish.
3. **Manage Existing Listings:**
   - Navigate to `/host/listings` to see Harsh's ~30 seeded Pune listings across 10 neighbourhoods.
   - Toggle availability rules (24x7 vs daytime).
4. **View Bookings & Sessions:**
   - Navigate to `/host/bookings` to see active and upcoming renter bookings across your listings.
5. **Host Earnings & Payouts:**
   - Navigate to `/host/earnings` to view gross earnings, platform commission breakdown, and net payable balances calculated from ledger entries.

---

### Tour 3: The Admin Journey (`asha@parkshare.local`)
1. **Sign In:** Go to `/dev/sign-in` and click **"Sign in as Asha"**.
2. **Host Verification:**
   - Navigate to `/admin/hosts`.
   - Find **Naveen Host** (`hostVerificationStatus: PENDING`).
   - Inspect their details and click **"Verify host"** to approve them.
3. **Dispute Resolution:**
   - Navigate to `/admin/disputes`.
   - Inspect the pre-seeded **OPEN** dispute filed by Riya (*"Security guard was away from Gate 2 for 45 minutes"*).
   - Review the evidence photos and resolve the dispute.
4. **Moderation:**
   - Navigate to `/admin/reports` to inspect the user report on listing accuracy.
   - Review reported listings and photos; approve or reject pending items.
5. **Payout Operations:**
   - Navigate to `/admin/payouts`.
   - Click **"Create Payout"** for Harsh Vardhan.
   - Select the completed bookings eligible for payout (which have passed the holdback window).
   - Review net payable amounts and create the payout batch.
   - Record the simulated bank transfer reference and click **"Mark as Paid"**.
6. **Background Jobs:**
   - Navigate to `/admin/jobs` to inspect the durable job queue, running jobs, completed tasks, and scheduled reconciliations.

---

## 5. Simulated vs Real Behavior

| Component | In Demo Mode (`DEMO_MODE=1`) | In Production (`NODE_ENV=production`) |
| :--- | :--- | :--- |
| **Authentication** | One-click instant DB session via `/dev/sign-in` (or standard magic link). | NextAuth.js magic link emails via Resend. `/dev/sign-in` returns 404. |
| **Payments** | `DemoProvider` simulates orders (`order_demo_*`), computes HMAC signatures with demo secret, and executes `settleTx` identically to real webhooks. | Razorpay Orders, Hosted Checkout script, and cryptographically verified Webhooks. |
| **Refunds** | `DemoProvider` records and marks refunds processed immediately; job reconciler reconciles ledger rows. | Razorpay Refunds API, webhook callbacks, daily job reconciliation. |
| **Photo Uploads** | Local multipart upload to `/api/dev/uploads`, stored under `public/uploads/` with magic-byte validation. | Cloudinary direct browser upload using server-signed HMAC signatures. |
| **Maps** | Interactive fallback map views and mock geocoding if `NEXT_PUBLIC_MAPBOX_TOKEN` is unset. | Full Mapbox GL interactive vector tiles and clustering. |
| **Notifications** | Stored in PostgreSQL `Notification` table and displayed in user inboxes; emails logged locally. | Delivered via Resend API to real user email inboxes. |

---

## 6. Plugging in Real Test Keys

You can gradually replace simulated services with real sandboxes by adding test keys to your `.env`:

```env
# 1. Razorpay Sandbox (Test Mode)
RAZORPAY_KEY_ID="rzp_test_YourTestKeyId"
RAZORPAY_KEY_SECRET="YourTestKeySecret"
RAZORPAY_WEBHOOK_SECRET="YourWebhookSecret"

# 2. Cloudinary Media Storage
CLOUDINARY_CLOUD_NAME="your-cloud-name"
CLOUDINARY_API_KEY="your-api-key"
CLOUDINARY_API_SECRET="your-api-secret"

# 3. Mapbox Visual Maps
NEXT_PUBLIC_MAPBOX_TOKEN="pk.eyJ1Ijoi..."

# 4. Resend Transactional Email
RESEND_API_KEY="re_123456789"
EMAIL_FROM="ParkShare <notifications@yourdomain.com>"
```

When real credentials are present in `.env`, the respective subsystem automatically upgrades from demo simulation to the real provider SDK while preserving all application flows.
