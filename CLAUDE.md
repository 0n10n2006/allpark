# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

ParkShare: a parking marketplace for India (pilot city: Pune). It is one Next.js 16 App Router app at the repo root, written in TypeScript (strict), with Prisma 7 on PostgreSQL 16 (`btree_gist` required), Auth.js v5, Razorpay, Cloudinary, Mapbox and Resend. `docs/PRD.md` is the product spec. `docs/IMPLEMENTATION_PLAN.md` §2 holds the binding architecture decisions. `docs/POLICY.md`, `docs/OPERATIONS.md` and `docs/API.md` cover policy, jobs/ops and the endpoint catalog.

## Commands

```bash
npm run setup:worktree -- <task_id>   # npm ci, creates parkshare_<id> + parkshare_<id>_test DBs, writes .env (per-worktree port 3100-3899), migrates, seeds
npm run dev                           # next dev (Turbopack)
npm run demo                          # migrate + seed demo personas + dev server + job worker; no external credentials (see docs/DEMO.md)
npm run worker                        # local job runner (polls the Job queue)
npm run typecheck                     # prisma generate && next typegen && tsc --noEmit
npm run lint
npm test                              # vitest: unit + real-Postgres integration tests
npx vitest run tests/booking          # one directory or file
npx vitest run -t "name of test"      # by test name
PERF=1 npx vitest run tests/search/perf   # search latency benchmark (opt-in)
npm run test:e2e                      # playwright; starts dev server on E2E_PORT
npx playwright test e2e/listing.spec.ts --project=desktop
npx tsx scripts/gen-api-doc.ts        # regenerate docs/API.md from src/contracts/registry.ts
```

- The Prisma client is generated into `src/generated/prisma/`, which is gitignored. Import it from `@/generated/prisma/client`. Run `npm run typecheck` or `npx prisma generate` after a schema change.
- Vitest runs files serially (`fileParallelism: false`). Before the suite starts, `tests/setup/global.ts` drops the `TEST_DATABASE_URL` schema and rebuilds it with `migrate deploy`. `DATABASE_URL` is remapped to the test DB. DB tests must use `testDb` and `truncateAll()` from `tests/setup/db.ts`, never `src/server/db.ts`.
- Playwright projects are `warmup`, which compiles all routes first, then `mobile` and `desktop`, plus a separate `demo` project for `demo.spec.ts`. Non-demo runs set fake Razorpay keys and point `RAZORPAY_API_URL` at a local mock server on `port + 1000`.

## Architecture

**Layering.** Route handlers in `src/app/api/**/route.ts` stay thin. Domain logic lives in `src/server/<module>/` (bookings, availability, payments, payouts, sessions, cancellations, disputes, monthly, jobs, notifications, search, ...). Each module owns its matching `src/app/api/<module>` and `tests/<module>` folders, which is also the task-ownership unit.

**Contracts.** The zod schemas in `src/contracts/*.ts` are shared by the server and the client. `src/contracts/registry.ts` lists every endpoint: method, path, auth mode, schemas and implementing task. `tests/contracts` checks that every entry has a route file, and `docs/API.md` is generated from the registry. When you add an endpoint, add its registry entry too.

**Route wrapper.** Every handler goes through `route({ auth, body, query, params, rateLimit }, handler)` from `src/server/http/route.ts`. The wrapper runs the same-origin check on mutations (Origin must match `AUTH_URL`), auth (`public` | `user` | `admin`), the rate limit and zod parsing, and it returns the standard error envelope (`HttpError` in `src/server/http/errors.ts`). Idempotency keys and audit logging are in the same folder. `src/proxy.ts` is Next 16's replacement for `middleware.ts`. It only redirects for UX; real auth is enforced in handlers and pages.

**Inventory and double-booking.** Only the `Booking` table claims inventory. A payment hold is a `Booking` in `PENDING_PAYMENT` with `holdExpiresAt`. Each monthly term is also a `Booking` (`rentalType = MONTHLY`). A raw-SQL exclusion constraint, `booking_no_overlap`, on `(listingId, blockedRange)` covers active statuses. `blockedRange` is a generated `tstzrange(startAt, blockedUntil)`, where `blockedUntil = endAt + turnover buffer`. The constraint cannot use `now()`, so stale holds must get their status flipped to `EXPIRED`. The hold-create transaction does this for overlapping holds, and a sweeper job does it every minute. `src/server/availability` is the only module that writes inventory. Booking status transitions are defined in `src/server/bookings/state.ts`.

**Jobs.** This is a Postgres-backed durable queue. Jobs are claimed with `FOR UPDATE SKIP LOCKED` and retried with backoff, and failures go to a dead-letter state. Handlers are registered with `registerJob(type, zodSchema, handler)` (`src/server/jobs/registry.ts`) and must be idempotent. In production they are triggered by `POST /api/cron/tick` (guarded by `CRON_SECRET`); locally, `npm run worker` runs them.

**Payments.** `src/server/payments/provider.ts` abstracts Razorpay. Settlement happens through the HMAC-verified webhook in `src/app/api/webhooks`. When payment succeeds but the booking fails because the hold expired and the slot was taken, the flow triggers an automatic refund. Payouts are `MANUAL` (recorded by an admin). `demo-provider.ts` is active only when `DEMO_MODE=1` and `NODE_ENV !== "production"` (`src/lib/demo.ts`).

**Policy.** Commission, hold TTL, grace period, cancellation tiers and similar values live in `src/config/policy.ts`. Quotes snapshot them into `PolicyVersion` rows.

**Shared libs.** `src/lib/money.ts` handles paise, `src/lib/time.ts` converts UTC to Asia/Kolkata, and `src/lib/env.ts` validates env with zod. In production it rejects placeholder values such as `replace-me`. The Prisma client in `src/server/db.ts` pins the session to UTC.
