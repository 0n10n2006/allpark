# ParkShare: agent rules

- Product source of truth: `docs/PRD.md`. Plan, architecture, and task list: `docs/IMPLEMENTATION_PLAN.md` (§2 decisions are binding).
- Do only your assigned Task. Edit only the paths your Task's Ownership lists. Ask the coordinator through the Orca `ask` command before touching anything else.
- Hotspot files have one owner (plan §3): `package.json`/lockfile, `prisma/schema.prisma` + `prisma/migrations/**`, `src/app/layout.tsx`, `middleware.ts`, `src/components/ui/**`. Never add dependencies or migrations unless your Task says so.
- Money is stored as integer paise plus `currency`. Times are UTC in the DB and shown in Asia/Kolkata. IDs are UUIDs.
- Every mutation does server-side zod validation and authorization. Never trust client amounts, ids, or statuses.
- Fake payment success may exist only in tests (`NODE_ENV=test`). Never commit secrets; `.env.example` holds placeholders only.
- Before reporting done: `npm run typecheck && npm run lint && npm test` must pass. Commit on your branch with a clear message.
