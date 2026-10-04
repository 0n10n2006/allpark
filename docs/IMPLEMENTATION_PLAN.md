# ParkShare — Implementation Plan (v1, awaiting approval)

Source of truth: `ParkShare_PRD_Implementation_Specification.docx` (v1.0, 16 Oct 2026).
Status: **PLAN ONLY.** No Orca Run, Task, or worker has been created. Nothing has been committed.

---

## 1. Repository inspection (PRD Appendix A, required report)

| Item | Finding |
|---|---|
| Framework / code | None. The repo contains only the PRD `.docx`. |
| Git | Branch `master`, **zero commits**. The tooling reports `main` as the default branch. No remote; `gh` is not logged in. |
| Database | No schema. **No Docker, `psql`, or PostgreSQL installed.** |
| Toolchain | Node 24.16, npm 11.13. No pnpm. `choco` is on PATH. |
| Tests / CI | None |
| Contradictions with PRD | None, because there is no code yet. Two process notes: (a) Orca worktrees need a base commit, and none exists; (b) the PRD asks for vertical slices, while the requested phases split backend from frontend. §4 reconciles the two. |

### Agent availability (verified 2026-10-16 through Orca 1.4.227)

| Agent | Orca status | Plan role |
|---|---|---|
| **Codex** (codex-cli 0.163.0) | ok, 0% session used, OAuth signed in | **Bulk implementation:** CRUD APIs, UI pages, jobs, docs, E2E |
| **Claude** (Claude Code 2.1.301) | ok, **65% session / 31% weekly used**. The coordinator draws on the same quota. | **Correctness-critical work only:** schema and exclusion constraint, booking engine, payments, security review, code review |
| **Antigravity** (Gemini-backed) | Usage reads "ok". **Not yet proven as a worker.** | Frontend and UX, a11y/perf tests. Used only if the smoke test passes. |
| **Cursor** | Usage reads "ok". **Not yet proven as a worker.** | Reserve |
| **Gemini CLI** (0.64.0 installed, OAuth creds present) | **Unverified.** Orca's usage tracker reports "Gemini CLI OAuth is disabled in settings". Whether `worker-start --agent gemini` works is unproven. | Frontend and tests if the smoke test passes. Otherwise Antigravity is the Gemini-model route. |

Phase 0 runs a trivial smoke `worker-start` on Codex, Antigravity, Cursor, and Gemini. An agent gets real work only after it returns a valid `worker_done`.

---

## 2. Architecture decisions (proposed defaults)

| Area | Decision | Rationale / ceiling |
|---|---|---|
| App | One Next.js (App Router) + TypeScript app at the repo root, using route handlers and `src/server/<module>` domain services | PRD §7. No monorepo; nothing needs one. |
| UI | Tailwind + shadcn/ui, PWA manifest + minimal service worker (installable, offline shell only) | PRD §2. Full offline support is out of scope. |
| DB | PostgreSQL 16 + Prisma; `btree_gist` extension; raw-SQL migration for the exclusion constraint | FR-04 |
| Geo | `lat`/`lng` columns + B-tree index; viewport bbox query plus haversine distance in SQL | PRD allows "PostGIS or equivalent". This is adequate at Pune scale. `ponytail:` upgrade to PostGIS if the p95 search target fails at load. |
| Auth | Auth.js (NextAuth v5) + Prisma adapter, email magic link; phone OTP behind a provider interface (decision Q4) | FR-01 |
| Validation | zod schemas in `src/contracts/*`, shared by route handlers and the client | One contract source for frontend and backend |
| Jobs | Postgres `Job` table: enqueue, then claim with `FOR UPDATE SKIP LOCKED`, retry with backoff, dead-letter. A `POST /api/cron/tick` endpoint is protected by `CRON_SECRET`; locally, `npm run worker` loops it. | Durable and adds no new service. Production trigger (Vercel Cron cadence vs an external scheduler) is decision Q7. |
| Payments | Razorpay Orders + Checkout + webhooks; `payoutMode = MANUAL` default (admin records payouts) until Razorpay Route/marketplace support is confirmed | PRD §6 "provider validation required" |
| Maps | Decision Q3 (Google Maps or Mapbox), behind one small `MapView` component + geocode function | FR-03 |
| Images | Cloudinary signed direct uploads; server verifies the public_id belongs to the listing | FR-02 / security |
| Email | Provider decision Q6. In dev and test, emails are written to the log and a `Notification` row. | FR-12 |
| Money | Integer paise (`Int`) + `currency` column everywhere | FR-05 |
| Time | UTC in the DB (`timestamptz`); Asia/Kolkata for input and display via one `src/lib/time.ts` | PRD §5 |
| Tests | Vitest (unit + integration against a real Postgres test DB), Playwright (E2E), axe-core (a11y) | PRD §11 |

### 2.1 Inventory design (pinned, because the FR-04 acceptance criteria depend on it)

- **One table claims inventory: `Booking`.** A hold *is* a `Booking` row in `PENDING_PAYMENT` with `holdExpiresAt`. This matches PRD §5, where PENDING_PAYMENT = "a hold exists". A `BookingHold` view/alias isn't needed. The PRD's `BookingHold` entity is satisfied by these columns.
- **Monthly terms are bookings too.** `MonthlyAgreement` owns the term metadata, and each paid term (initial + each renewal) is a `Booking` row with `rentalType = MONTHLY`. Monthly and short-term reservations therefore share one conflict check (FR-04, FR-09).
- `Booking.blockedRange tstzrange` = `tstzrange(startAt, blockedUntil)`. The service sets `blockedUntil = endAt + turnover buffer`, and `CHECK (blockedUntil >= endAt)` guards it. The range is a generated column, which works because `tstzrange` is immutable. `timestamptz + interval` is not immutable, so it can't appear in the generated column.
- **Exclusion constraint** (raw SQL migration):
  `EXCLUDE USING gist ("listingId" WITH =, "blockedRange" WITH &&) WHERE (status IN ('PENDING_PAYMENT','CONFIRMED','ACTIVE','GRACE_PERIOD','OVERSTAY','DISPUTED'))`
  The predicate cannot use `now()`. Expired holds must therefore have their *status flipped*:
  1. The hold-create transaction first sets `EXPIRED` on overlapping holds whose `holdExpiresAt < now()` (DB time), then inserts.
  2. A sweeper job expires all stale holds every minute, so inventory frees even if no one tries to book (FR-04 "browser closed").
- Payment confirmation re-checks hold validity in a transaction. If the hold expired and the slot was taken, the booking becomes `PAYMENT_FAILED`-equivalent with an automatic refund flow. This is the PRD's "payment-success/booking-failure" case.
- An extension updates `endAt`/`blockedRange` in a transaction. The constraint rejects any conflict.
- Availability service (`src/server/availability`) is the **only** caller that writes inventory. It handles schedule rules, exceptions, and operating hours before the insert.

### 2.2 Configurable policy (PRD open decisions become config with placeholder defaults)

`src/config/policy.ts` + `PolicyVersion` rows (snapshotted on each quote):

| Key | Placeholder default | Blocks |
|---|---|---|
| `commissionBps` | 1000 (10%, PRD example) | Phase 2 pricing, though the value can change before launch |
| `renterFeeBps` | 0 | — |
| `holdTtlMinutes` | 10 | Phase 2 |
| `gracePeriodMinutes` | 10 (PRD) | Phase 4 |
| `reminderOffsetsMinutes` | [30, 10] (PRD) | Phase 4 |
| `overstayFeeEnabled` | **false**. The PRD forbids undisclosed fees, and a fee needs legal review. | — |
| `cancellationPolicy` | tiered placeholder per rental type | Phase 4 refunds |
| `monthlyRenewalReminderDays` / `unpaidGraceDays` | 7 / 0 | Phase 4 |
| `payoutMode` | `MANUAL` | Phase 4 payouts |
| `cityBoundary` | Pune bbox | Phase 2 search |

---

## 3. Orchestration model

- **One Orca Run** for the whole project. Every unit of work is an Orca Task created with `task-create --deps`, and every worker is a supervised `worker-start`. No non-Orca subagents are used.
- **Placement:** each implementation Task gets an Orca `new-child` worktree (branch `feat/<task-id>-<slug>`) from the integration branch. Review-only tasks run in `current`.
- **Integration:** the coordinator reviews each diff, runs `npm run typecheck && npm run lint && npm test` on the branch, then merges locally `--no-ff` into the integration branch. Merges are local only, because there is no remote and no `gh` auth. Dependent tasks start only after their deps are merged.
- **Per-worker database:** each worker gets its own database (`parkshare_<taskid>` and `parkshare_<taskid>_test`) on the same local Postgres server, passed in the Task spec. No two workers share a database.
- **Hotspot ownership (conflict avoidance):**

  | File(s) | Owner | Others may |
  |---|---|---|
  | `package.json`, `package-lock.json` | T1.1 installs *all* expected deps up front; afterwards only the coordinator | Ask through `orca orchestration ask` for a new dep |
  | `prisma/schema.prisma`, `prisma/migrations/**` | T1.2, then the coordinator only. Later schema changes are serialized as tiny coordinator-merged migration tasks. | Ask; never create migrations |
  | `src/app/layout.tsx`, `middleware.ts`, `src/components/ui/**` (shadcn) | T1.5 / T1.3; afterwards the coordinator | Use, not edit |
  | `src/contracts/**` | T2.0; later additive edits are allowed only in the task's own module file | Add their own file |
  | `src/config/policy.ts` | T2.2 | Read |

- **Task spec template** (Orca's five fields): **Target**, **Change**, **Constraints** (including "no mock payment success outside test", "server-side authz for every mutation", hotspot rules, the PRD sections to read), **Ownership** (exact dirs), **Observable acceptance** (named test files + the FR acceptance bullets they prove + `npm test` green).
- **Ownership by directory:** each task owns its module, `src/server/<module>/**`, `src/app/api/<module>/**`, and `tests/<module>/**`, plus the UI route group named in its row. A task touching outside that set asks first.
- **DAG creation is per phase.** Tasks are created one phase at a time, after the previous phase merges, so no dependency chain in Orca exceeds 3–4 levels.
- **Supervision loop:** `check --wait --types worker_done,escalation,question`. Answer questions, then validate each `worker_done` against the expected Dispatch, then review the diff, merge or send fixes, then `worker-release` or reuse the terminal. After 3 empty waits, run `worker-list --run <id>`. Stop, abandon, or retry happens only on positive proof of exit.
- **Review:** every Claude/Codex implementation merge into a correctness-critical area (inventory, payments, auth) gets a Claude review task first. Review findings become fix tasks; the coordinator does not hand-edit.

---

## 4. Phases, tasks, and dependencies

Reconciling the requested phase split with the PRD's vertical slices: **Phase 2 delivers API contracts (`src/contracts`, zod + types, with 501 route stubs) first.** Phase 3 frontend then builds against those contracts in parallel with the Phase 2 implementations. Each vertical slice is closed in Phase 4, where UI, API, and jobs are wired end to end.

Agent key: **CX** = Codex, **CL** = Claude, **AG** = Antigravity (if the smoke test passes, else CX). "→" = depends on.

### Phase 0 — Bootstrap (coordinator; needs your approval)

| ID | Task | Acceptance |
|---|---|---|
| T0.1 | Create integration branch (Q1). First commit: `.gitignore` (`.env*`, `node_modules`, `.next`), `docs/PRD.md` (markdown conversion of the .docx, because workers can't read docx), this plan, and the .docx itself. | `git log` shows 1 commit; worktrees can branch |
| T0.2 | Provision PostgreSQL 16 (Q2) and verify `CREATE EXTENSION btree_gist` | `psql -c "select 1"` OK; extension creates |
| T0.3 | Orca smoke: one Run; trivial "write `hello.txt`, report `worker_done`" Task on CX, AG, Cursor, Gemini in `new-child` worktrees; release all | Each agent returns a valid `worker_done`; roster in §1 updated |

### Phase 1 — Architecture & foundation

| ID | Agent | Deps | Task | Observable acceptance |
|---|---|---|---|---|
| T1.1 | CX | T0.* | Scaffold Next.js+TS+Tailwind+shadcn init, ESLint/Prettier, Vitest + Playwright configs, `src/lib/env.ts` (zod-validated env), `.env.example` (placeholders only), PWA manifest/icons, npm scripts (`dev`, `build`, `typecheck`, `lint`, `test`, `test:e2e`, `db:*`, `worker`). **Install every dependency listed in §2.** `npm run setup:worktree -- <taskid>`: `npm ci`, create `parkshare_<taskid>` + `_test` DBs, write `.env.local`, migrate, seed. Every later task spec points to this script. | `npm run build`, `typecheck`, `lint`, `test` pass; app serves `/`; `setup:worktree` works in a fresh worktree |
| T1.2 | CL | T1.1 | Full Prisma schema for all PRD §8 entities (+ `Job`, `PolicyVersion`, `IdempotencyKey`, `ProviderEvent`, `RateLimit`, Auth.js tables). UUID PKs, paise ints, separate booking/payment/refund/payout/dispute state enums. Raw SQL migration: `btree_gist`, `blockedRange`, exclusion constraint, indexes (geo, status, interval). Pune seed (hosts, ~50 listings, rules, vehicles, admin). | `prisma migrate reset` + seed succeed; `tests/db/exclusion.test.ts` proves overlapping active rows are rejected, adjacent `[a,b)`/`[b,c)` are accepted, and EXPIRED rows don't block. The range is declared `Unsupported("tstzrange")` in `schema.prisma`, and a second `prisma migrate dev` generates **no** new migration (no drift). |
| T1.3 | CX | T1.2 | Auth.js (email magic link; dev logs link), roles (RENTER/HOST/ADMIN as permissions on one account), `requireUser/requireRole/assertOwner`, route-handler wrapper (zod parse, error envelope, rate limit, audit hook), idempotency-key helper, `AuditLog` writer, middleware protecting `/host`, `/admin`, `/bookings` | `tests/auth/*.test.ts`: unauthenticated mutation → 401, non-admin → 403 on admin stub, rate limit trips, idempotent replay returns the same response (FR-01) |
| T1.4 | CX | T1.2 | Job runner (`src/server/jobs`): enqueue with idempotency key, claim with SKIP LOCKED, retry/backoff, dead-letter, `/api/cron/tick` (CRON_SECRET), `npm run worker` | `tests/jobs/*.test.ts`: two concurrent claimers never run the same job; failed job retries then dead-letters; scheduled job waits for `runAt` |
| T1.5 | AG | T1.1 | App shell & design system: layout, mobile bottom nav (Explore / Bookings / Host / Account), tokens, `time.ts` IST formatting, money formatter (paise→₹), shared Loading/Empty/Error/Recovery components, a11y baseline | Playwright smoke at 375px renders the shell, no horizontal scroll; axe: 0 serious violations |

Parallel waves: T1.1 → {T1.2, T1.5} → {T1.3, T1.4}

### Phase 2 — Database, backend & API contracts

| ID | Agent | Deps | Task | Observable acceptance (FR) |
|---|---|---|---|---|
| T2.0 | CL | T1.3 | API contracts: zod request/response schemas + types for every PRD §7 endpoint plus listing/vehicle/profile/admin endpoints; 501 route stubs; `docs/API.md` generated from them | `typecheck` passes; every PRD §7 endpoint exists and returns 501 |
| T2.1 | CL | T2.0, T1.4 | **Availability + booking engine:** schedule/exception/hours validation, conflict check, hold create (with stale-hold expiry in the txn), booking state machine (PRD §5 transitions only), hold-expiry sweeper job, `GET/POST /api/bookings*` (hold, get, cancel-request skeleton) | `tests/booking/concurrency.test.ts`: 20 parallel holds on one slot → exactly 1 succeeds and the rest get **409** (Postgres `23P01` mapped, never 500); expired holds free inventory via the sweeper; monthly term blocks short-term; adjacent bookings honour the buffer (FR-04, FR-09 AC1) |
| T2.2 | CX | T2.0 | Pricing & quotes: hourly/daily/multi-day/weekly/monthly calc, min duration, discounts, commission bps, tax placeholder, persisted `PriceQuote` with line items/version/expiry, `POST /api/quotes`, `policy.ts` | `tests/pricing/*.test.ts`: table-driven totals in paise; ₹500 → ₹50 commission → ₹450 host; tampered client amount is ignored; expired quote rejected (FR-05) |
| T2.3 | CX | T2.0 | Listings: create/update/owned list, publish validation (required fields, Pune boundary, ≥1 photo, attestation), host verification status gate, Cloudinary signed upload + ownership check, availability rules/exceptions endpoint, suspension excludes from search, precise address/instructions hidden pre-booking | `tests/listings/*.test.ts`: unverified host can't publish; missing photo blocks publish; non-owner PATCH → 403; public GET returns approximate coords only (FR-02, FR-01 AC2) |
| T2.4 | CX | T2.1 | Search: `GET /api/listings` bbox/radius + filters (time window via availability service, rental type, price, vehicle, covered, dimensions, amenities), ranking by distance/price | `tests/search/*.test.ts`: a listing booked for the requested window is excluded; a monthly-blocked listing is excluded; suspended listing is excluded; seeded 5k-listing p95 < 1 s locally (FR-03) |
| T2.5 | CX | T2.0 | Users: profile, vehicles CRUD (multiple), preferences, notification settings, account-deletion request | `tests/users/*.test.ts`: user can't read/edit another user's vehicle (FR-01 AC3/AC4) |
| T2.6 | CX | T1.4 | Notifications module: templates, in-app inbox API, email via provider adapter (log adapter in dev/test), delivery status, idempotency key, retry through jobs, no sensitive data in previews | `tests/notifications/*.test.ts`: duplicate send with same key → one delivery; failure retries (FR-12) |

Wave A (parallel): T2.0, T2.6 → Wave B (parallel): T2.1, T2.2, T2.3, T2.5 → T2.4

### Phase 3 — Frontend & UX (builds against `src/contracts`, parallel to Phase 2 B)

| ID | Agent | Deps | Task | Observable acceptance |
|---|---|---|---|---|
| T3.1 | AG | T2.0, T1.5 | Explore: map with price markers + synced list, destination search (geocode), current location with denied/unsupported states, filters sheet, "Search this area", listing preview cards, directions handoff | Playwright: pan → "Search this area" refetches; location denied still searches by text; loading/empty/error states render (FR-03 AC3/AC4) |
| T3.2 | AG | T2.0, T1.5 | Listing detail + checkout UI: photos, approximate pin, rules/terms/cancellation/grace display, vehicle selection, server quote, hold countdown, payment step placeholder | Playwright: terms + all charges are visible before the pay button (FR-05, FR-08 AC1) |
| T3.3 | CX | T2.0, T1.5 | Host area: onboarding/verification status, listing wizard (photos via signed upload, map pin, access instructions, rules, limits, prices, availability editor, attestation), my listings, incoming bookings | Playwright: create → publish happy path against the real API once T2.3 merges |
| T3.4 | CX | T2.0, T1.5 | Account: sign-in, profile, vehicles, notification preferences, deletion request | Playwright: add 2 vehicles; accessible form errors |
| T3.5 | AG | T2.0, T1.5 | Renter bookings: upcoming/active/past, active-session screen (end time, remaining time, Start parking, extend, report problem, checkout), monthly status card, receipt | Component tests for each state; 375px layout |

Frontend tasks wire to the real API as soon as the matching Phase 2 task merges. Until then they render against contract-typed fixtures under `tests/fixtures` (never in production paths).

### Phase 4 — Integrations & complete user journeys

| ID | Agent | Deps | Task | Observable acceptance (FR) |
|---|---|---|---|---|
| T4.1 | CL | T2.1, T2.2 | **Payments:** `POST /api/payments/order` (trusted total from quote), Razorpay Checkout in T3.2's UI, signature verify, `/api/webhooks/razorpay` (raw body HMAC, `ProviderEvent` dedupe), atomic confirm with hold revalidation, payment-success/booking-failure auto-refund, ledger (gross, commission, host earnings), refund state machine + provider reconcile job | `tests/payments/*.test.ts` (self-signed HMAC with test secret): bad signature → 401; duplicate webhook → no second booking; client callback alone doesn't confirm; delayed webhook confirms later; refund ≤ captured minus prior refunds (FR-06) |
| T4.2 | CX | T4.1, T2.6 | Session workflow: check-in window, host confirm, `SessionEvent` log, reminder jobs (30/10 min), extension (fresh availability + payment), GRACE → OVERSTAY transition jobs, overstay incident + host evidence upload, no auto-penalty on missed checkout | `tests/sessions/*.test.ts` with a fake clock: reminders enqueued at the right times; conflicting extension rejected; grace expiry opens an incident and notifies both parties (FR-07, FR-08) |
| T4.3 | CX | T4.1 | Monthly rentals: agreement creation, manual renew (`/api/monthly/:id/renew` → revalidate + quote + payment), renewal reminder job, unpaid expiry policy job, history | `tests/monthly/*.test.ts`: renewal blocked when the next term conflicts; there is no code path that charges without renter action; expiry is audited (FR-09) |
| T4.4 | CX | T4.1 | Cancellation & refunds per policy (renter/host/unavailable/access failure/duplicate charge), disputes API, reviews (completed bookings only), reports | `tests/disputes/*.test.ts`: cancellation state is independent of refund state; review on a non-completed booking → 403 (FR-10, FR-11) |
| T4.5 | CX | T4.1 | Host earnings & payouts: `GET /api/host/earnings`, payout records, MANUAL mode (admin records the payout + provider ref), idempotent payout creation, reconciliation view | `tests/payouts/*.test.ts`: the same earnings can't be paid out twice; ledger sums reconcile (FR-06 AC5/AC6) |
| T4.6 | AG | T4.4, T4.5 | Admin console UI + APIs: search users/listings/bookings/payments, host verification review, suspend, moderation queues, dispute/overstay timeline, refund/payout reconciliation, failed jobs/notifications; reason required + `AuditLog` on every action | `tests/admin/*.test.ts`: non-admin → 403 on all admin routes; every mutation writes AuditLog with a reason (FR-13) |
| T4.7 | CX | T3.*, T4.1 | Journey wiring: replace fixtures with the live API on the Phase 3 screens **except** `src/app/(renter)/bookings/**`, which T4.2 owns; notifications inbox UI | No imports of `tests/fixtures` from `src/` (lint rule) |

Waves: T4.1 → {T4.2, T4.3, T4.4, T4.5, T4.7} → T4.6

### Phase 5 — Testing, security review, bug fixes

| ID | Agent | Deps | Task | Acceptance |
|---|---|---|---|---|
| T5.1 | CX | Phase 4 | Playwright E2E: renter search → quote → hold → Razorpay *test mode* (or signed simulated webhook in the test env only) → confirm → check-in → checkout → review; host signup → listing → booking → earnings; monthly renew | All journeys green in CI script |
| T5.2 | CL (review-only) | Phase 4 | Security review: authz/IDOR matrix over every route, webhook, rate limits, uploads, XSS/CSRF, secrets/log leakage, privacy of precise location | Findings report → fix tasks (CX) |
| T5.3 | AG | Phase 4 | Accessibility (axe on all pages, keyboard pass), responsive 360–1440 px, slow-network/interrupted checkout/refresh recovery, search p95 load test | axe 0 serious; report of results |
| T5.4 | CL | Phase 4 | Concurrency & jobs hardening: booking race under load, webhook storms, job crash/retry, hold expiry with browser closed | Tests added and green |
| T5.5 | CX/CL | T5.2–T5.4 | Bug-fix wave from findings (one task per finding cluster) | Each finding closed with a test |

### Phase 6 — Final verification & deployment preparation (no deploy)

| ID | Agent | Task |
|---|---|---|
| T6.1 | CX | Docs: README (local setup, migrations, seed, tests), `docs/OPERATIONS.md` (jobs, cron, webhook setup, reconciliation, backup/restore, recovery runbooks), `docs/DEPLOYMENT.md` (Vercel + managed Postgres + cron/scheduler) |
| T6.2 | Coordinator | PRD traceability matrix: every FR acceptance bullet → test file. Full test suite run with results summary. |
| T6.3 | Coordinator | Launch-gate checklist (PRD §11). Code-verifiable gates are marked; business/legal gates (Razorpay marketplace confirmation, tax, terms, privacy) are flagged for you. |

**Critical path:** T0 → T1.1 → T1.2 → T1.3 → T2.0 → T2.1 → T4.1 → T4.2/T4.3 → T5 → T6.

---

## 5. Definition of done per task (PRD Appendix B, enforced at review)

Acceptance tests pass; typecheck/lint clean; server-side authz + zod validation on every mutation; idempotency where money or inventory moves; loading/empty/error/recovery UI states; audit records without sensitive data in logs; `.env.example`/docs updated; no secrets or real PII committed; mock payment success appears only under `NODE_ENV=test`.

## 6. Decisions needed

| # | Question | Recommended default | Blocks |
|---|---|---|---|
| Q1 | Integration branch: rename `master` → `main`? | Yes, `main` | Phase 0 |
| Q2 | PostgreSQL 16 for dev/test: (a) local install via `choco install postgresql16` (admin prompt), (b) managed dev DB (Neon/Supabase; you sign up), (c) `embedded-postgres` npm package (no system install; btree_gist availability to verify) | (a) local install | Phase 1 (T1.2) |
| Q3 | Maps provider: Google Maps Platform or Mapbox | Mapbox (simpler pricing, good geocoding); API key needed | Phase 3 (T3.1) |
| Q4 | Auth for MVP: email magic link only, or also phone OTP (needs an SMS provider such as MSG91/Twilio + DLT registration in India) | Email now; phone OTP behind an interface later | Phase 1 (T1.3) |
| Q5 | Razorpay **test-mode** keys + webhook secret; Cloudinary account | Provide by T4.1 / T2.3. Tests run without them (self-signed HMAC; mocked upload signature). | Phase 2/4 live runs |
| Q6 | Transactional email provider | Resend (logs to console in dev) | Phase 4 live sends |
| Q7 | Production job trigger: Vercel Cron (per-minute cadence needs a paid plan) vs an external scheduler hitting `/api/cron/tick` | Decide at deploy; code is trigger-agnostic | Phase 6 |
| Q8 | Gemini: should I try `--agent gemini` in the smoke test, or skip it and use Antigravity? | Try it in the smoke test | Phase 0 |
| Q9 | Accept the §2.2 policy placeholders (10% commission, 10-min hold TTL, 10-min grace, 30/10-min reminders, no overstay fee, manual payouts) for development? | Yes; final values stay open-launch decisions | Phase 2 |

## 7. Things this plan will not do without your approval

Deploy anything; create accounts or purchase services (Razorpay, Cloudinary, maps, email, managed DB, Vercel); push to any remote; install system software (Postgres); delete or rewrite history.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Claude quota (65% session used) runs out mid-run | Codex carries bulk work; Claude tasks are kept small and scheduled after quota reset when possible |
| Razorpay marketplace/payout capability unconfirmed | `payoutMode=MANUAL` default; no escrow/split claims in the UI (PRD §6) |
| Schema churn across parallel worktrees | Single schema owner; serialized migration tasks |
| Antigravity/Cursor unproven | Smoke test first; fall back to Codex |
| "Production-ready" includes non-code gates | T6.3 lists them explicitly; code cannot satisfy legal/provider confirmations |
