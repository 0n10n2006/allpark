# ParkShare

ParkShare is a community-driven peer-to-peer and commercial parking marketplace for India (initial pilot: Pune). It connects drivers searching for reliable parking with homeowners, housing societies, and commercial facility operators who have underutilized parking spaces.

ParkShare supports hourly, daily, multi-day, weekly, and monthly reservations. The platform enforces strict double-booking prevention through PostgreSQL exclusion constraints, provides fast geospatial discovery (search p95 < 100ms across thousands of spaces), supports Razorpay payments and webhooks, provides automated session tracking with grace periods, and includes an administrative operations console for payouts, dispute resolution, and incident handling.

---

## Tech Stack

- **Framework:** [Next.js 16](https://nextjs.org/) (App Router, Turbopack, React 19)
- **Language:** TypeScript 5 (Strict Mode)
- **Styling & UI:** Tailwind CSS v4, Base UI / Radix primitives, Lucide icons, Sonner toasts
- **Database & ORM:** PostgreSQL 16 with `btree_gist` extension, [Prisma 7](https://www.prisma.io/) with `@prisma/adapter-pg` driver adapter
- **Authentication:** [NextAuth.js v5](https://authjs.dev/) (Auth.js beta) with Prisma adapter
- **Payments:** Razorpay Orders, Hosted Checkout, Webhooks, and Refunds
- **Geospatial & Maps:** Mapbox GL (`mapbox-gl`, `react-map-gl`) with coordinate fuzzing for unbooked listings
- **Media Storage:** Cloudinary (direct client uploads with server-signed HMAC signatures)
- **Transactional Notifications:** Resend API with local `LogSender` fallback for development and testing
- **Testing:** [Vitest](https://vitest.dev/) (unit & database integration), [Playwright](https://playwright.dev/) (E2E with route mocking and warmup), [axe-core](https://www.deque.com/axe/) (accessibility)

---

## Prerequisites

1. **Node.js:** Node.js `24.x` (LTS) and `npm 10+`.
2. **PostgreSQL:** PostgreSQL `16.x` server running locally or accessible over the network.
   - The PostgreSQL instance **must** support the `btree_gist` extension (required for exclusion constraints guarding overlapping booking ranges).
   - Ensure the extension is enabled in your database or template:
     ```sql
     CREATE EXTENSION IF NOT EXISTS btree_gist;
     ```
3. **Windows Notes:**
   - ParkShare is fully developed and tested on Windows 11 with PowerShell.
   - When executing commands with environment variables in PowerShell, use PowerShell syntax:
     ```powershell
     # Setting environment variables for a single command in PowerShell:
     $env:PERF="1"; npx vitest run tests/search/perf
     ```
   - When passing paths containing parenthesis in PowerShell (such as `src/app/(admin)`), wrap the path in single quotes: `'src/app/(admin)'`.

---

## Quick Start

### 1. PostgreSQL Admin Connection

ParkShare uses an automated worktree setup script that provisions isolated development and test databases per task or worktree.

Create the admin connection URL file:

```powershell
# Put your PostgreSQL admin connection URL into:
# %USERPROFILE%\.parkshare\pg-admin-url
mkdir -p "$HOME\.parkshare"
Set-Content -Path "$HOME\.parkshare\pg-admin-url" -Value "postgresql://postgres:postgres@localhost:5432/postgres"
```

_(Alternatively, export the environment variable `PARKSHARE_PG_ADMIN_URL`.)_

### 2. Setup Worktree & Isolated Databases

Run `setup:worktree` with a task identifier (letters, numbers, underscores):

```bash
npm run setup:worktree -- local_dev
```

_Executed successfully during local setup._

This command:

1. Runs `npm ci` and generates the Prisma client.
2. Connects to PostgreSQL using your admin URL.
3. Creates two isolated databases: `parkshare_local_dev` (development) and `parkshare_local_dev_test` (automated testing).
4. Assigns a deterministic per-worktree port in `3100-3899` to prevent port collisions between parallel checkouts.
5. Writes `.env` with all necessary local secrets and connection URLs.
6. Runs `prisma migrate deploy` to apply all migrations.
7. Executes `npm run db:seed` to seed sample Pune listings and policy version 1.

### 3. Start Development Server

```bash
npm run dev
```

_Executed successfully during local setup._

Open [http://localhost:3000](http://localhost:3000) (or the specific port assigned in your `.env`, e.g., `http://localhost:3100`).

---

## NPM Scripts

| Script           | Command                                                                     | Description                                                                |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `dev`            | `next dev`                                                                  | Starts the Next.js development server with Turbopack.                      |
| `build`          | `next build`                                                                | Compiles the production application bundle.                                |
| `start`          | `next start`                                                                | Runs the compiled production application.                                  |
| `lint`           | `eslint`                                                                    | Executes ESLint across all source and test files.                          |
| `typecheck`      | `prisma generate && next typegen && tsc --noEmit`                           | Generates Prisma client, Next.js types, and runs TypeScript type checking. |
| `format`         | `prettier --write .`                                                        | Formats all source files with Prettier.                                    |
| `test`           | `vitest run`                                                                | Runs unit tests and PostgreSQL integration test suites.                    |
| `test:e2e`       | `playwright test`                                                           | Runs end-to-end browser tests with Playwright.                             |
| `db:migrate`     | `prisma migrate dev`                                                        | Creates and applies new migrations during schema development.              |
| `db:deploy`      | `prisma migrate deploy`                                                     | Applies pending migrations in production or CI/CD pipelines.               |
| `db:reset`       | `prisma migrate reset`                                                      | Drops and recreates the database and applies all migrations.               |
| `db:seed`        | `node --env-file-if-exists=.env --import tsx prisma/seed.ts`                | Seeds Pune development listings, test users, and policy version 1.         |
| `db:studio`      | `prisma studio`                                                             | Opens the Prisma Studio web UI for viewing database records.               |
| `worker`         | `node --env-file-if-exists=.env --import tsx src/server/jobs/worker-cli.ts` | Runs the background job processor worker polling the `Job` queue every 5s. |
| `setup:worktree` | `node scripts/setup-worktree.mjs`                                           | Provisions isolated databases, `.env`, runs migrations, and seeds DB.      |
| `postinstall`    | `prisma generate`                                                           | Automatically generates Prisma client after package installations.         |

---

## Project Structure

```
.
├── docs/                     # Architecture, operations, policy, and API documentation
│   ├── API.md                # Generated API endpoints catalog (from route contracts)
│   ├── DEPLOYMENT.md         # Production deployment, infrastructure, and CI/CD guide
│   ├── IMPLEMENTATION_PLAN.md# Engineering plan, architecture invariants, and milestones
│   ├── OPERATIONS.md         # Ops runbooks, background jobs, payouts, and disaster recovery
│   ├── POLICY.md             # Platform policies, fees, grace periods, and cancellation tiers
│   └── PRD.md                # Product Requirements Document & specifications
├── e2e/                      # Playwright end-to-end tests
│   ├── checkout-pay.spec.ts  # End-to-end booking and fake Razorpay checkout tests
│   └── warmup.setup.ts       # Pre-compilation warmup for Next.js routes
├── prisma/                   # Database schema, migrations, and seeds
│   ├── migrations/           # Versioned SQL migrations (includes btree_gist exclusion constraints)
│   ├── schema.prisma         # Prisma schema definition
│   └── seed.ts               # Pune development dataset and policy seed
├── scripts/                  # Developer and automation scripts
│   ├── gen-api-doc.ts        # Regenerates docs/API.md from contracts registry
│   ├── seed-search-perf.ts   # High-speed set-based seeding of 5,000+ perf listings
│   └── setup-worktree.mjs    # Worktree database and environment orchestrator
├── src/
│   ├── app/                  # Next.js App Router
│   │   ├── (admin)/          # Admin back-office pages (moderation, payouts, disputes)
│   │   ├── api/              # API endpoints (all validate schemas with Zod)
│   │   │   ├── admin/        # Support and admin management endpoints
│   │   │   ├── bookings/     # Booking lifecycle (hold, check-in, check-out, extend)
│   │   │   ├── cron/tick/    # Scheduled job trigger endpoint (CRON_SECRET protected)
│   │   │   ├── listings/     # Listing creation, search, and availability
│   │   │   ├── payments/     # Razorpay order generation and checkout confirmation
│   │   │   └── webhooks/     # Razorpay webhook consumer with HMAC verification
│   │   ├── bookings/         # User booking status and management pages
│   │   ├── host/             # Host dashboard (listings, calendar, earnings)
│   │   └── page.tsx          # Homepage with geospatial search and map
│   ├── config/               # Platform configuration and policy defaults (policy.ts)
│   ├── contracts/            # Single source of truth for Zod schemas and API DTOs
│   ├── lib/                  # Shared utilities (env validation, time/timezone, currency paise)
│   └── server/               # Pure backend business logic modules
│       ├── availability/     # Inventory calculation, hold sweeper, exclusion checking
│       ├── bookings/         # Booking state machine and transition guards
│       ├── cancellations/    # Cancellation refund calculation and notification
│       ├── disputes/         # Dispute filing, evidence verification, and admin resolution
│       ├── jobs/             # Database-backed durable job queue runner and registry
│       ├── notifications/    # In-app inbox and Resend transactional email deliverer
│       ├── payments/         # Razorpay provider client, webhook settlement, and reconciliation
│       ├── payouts/          # Manual host payout batching, ledger accounting, reconciliation
│       └── sessions/         # Session timer tracking, grace period, and overstay incidents
└── tests/                    # Vitest unit and PostgreSQL integration tests
    ├── booking/              # Concurrency, state transitions, and hold tests
    ├── cancellations/        # Tiered refund policy tests
    ├── http/                 # Route guards, CSRF/origin checks, and rate limits
    ├── jobs/                 # Queue claiming, exponential backoff, and dead-letter tests
    ├── payments/             # Webhook idempotency, signatures, and refund reconciliation
    ├── search/perf.test.ts   # Geospatial search benchmark (PERF=1)
    └── setup/                # Global Vitest setup (resets test DB schema before suite)
```

---

## Testing Guide

### 1. Unit & Database Integration Tests

ParkShare executes integration tests against an actual PostgreSQL test database. The test suite automatically resets and runs migrations on `TEST_DATABASE_URL` before test execution.

```bash
# Run all unit and integration test suites:
npm test
```

_Executed successfully in this worktree (34 passed suites, 485 passed tests)._

Vitest configuration notes (`vitest.config.ts`):

- `fileParallelism: false`: DB integration tests share the dedicated test database and run serially to prevent transactional deadlocks.
- `globalSetup`: Executes `tests/setup/global.ts` to migrate the test database cleanly before running tests.
- `DATABASE_URL` is automatically remapped to `TEST_DATABASE_URL`.

### 2. End-to-End Tests (Playwright)

Playwright tests verify browser interactions, checkout flows, and host actions.

```bash
# Run end-to-end tests:
npm run test:e2e
```

_Playwright config notes (`playwright.config.ts`):_

- Automatically boots the local dev server using the per-worktree port (`E2E_PORT`).
- **Warmup Project:** The `warmup` project compiles all routes once (`e2e/warmup.setup.ts`) before functional specs execute, absorbing Next.js on-demand compilation latency on Windows.
- **Provider Mocking:** Playwright tests run with local route mocking for Cloudinary direct uploads and spawn an ephemeral mock Razorpay API server to test payments without live credentials.

### 3. Search Performance Benchmark (`PERF=1`)

The PRD requires search p95 latency under 1 second over 5,000 published listings with schedules, bookings, and spatial indexes.

```powershell
# In PowerShell:
$env:PERF="1"; npx vitest run tests/search/perf
```

_Executed successfully in this worktree:_

- Seeded 5,000 listings across the Pune bounding box in set-based SQL.
- Benchmark result: `search p50 = 16.4ms`, `search p95 = 65.7ms`, `max = 86.6ms`.

---

## Key Documentation

- **[Operations Guide](docs/OPERATIONS.md):** Background jobs queue, worker configuration, Razorpay webhook setup, reconciliation, manual payouts runbook, incident playbooks, and backup/restore drills.
- **[Deployment Guide](docs/DEPLOYMENT.md):** Production Vercel & managed PostgreSQL setup, cron scheduler options, environment variables reference, and pre-launch checklists.
- **[Policy Reference](docs/POLICY.md):** Configurable platform rules in `src/config/policy.ts` (commission, cancellation refund tiers, grace period, payout hold-backs) and `PolicyVersion` snapshotting.
- **[API Reference](docs/API.md):** Full catalog of all 69 REST endpoints, authentication rules, idempotency requirements, and request/response DTO schemas.
- **[PRD](docs/PRD.md):** Product Requirements Document source of truth.
- **[Implementation Plan](docs/IMPLEMENTATION_PLAN.md):** System architecture, data flow invariants, and task ownership rules.
