# ParkShare: agent rules

- Product source of truth: `docs/PRD.md`. Plan, architecture, and task list: `docs/IMPLEMENTATION_PLAN.md` (§2 decisions are binding).
- Do only your assigned Task. Edit only the paths your Task's Ownership lists. Ask the coordinator through the Orca `ask` command before touching anything else.
- Hotspot files have one owner (plan §3): `package.json`/lockfile, `prisma/schema.prisma` + `prisma/migrations/**`, `src/app/layout.tsx`, `middleware.ts`, `src/components/ui/**`. Never add dependencies or migrations unless your Task says so.
- Money is stored as integer paise plus `currency`. Times are UTC in the DB and shown in Asia/Kolkata. IDs are UUIDs.
- Every mutation does server-side zod validation and authorization. Never trust client amounts, ids, or statuses.
- Fake payment success may exist only in tests (`NODE_ENV=test`). Never commit secrets; `.env.example` holds placeholders only.
- Before reporting done: `npm run typecheck && npm run lint && npm test` must pass. Commit on your branch with a clear message.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
