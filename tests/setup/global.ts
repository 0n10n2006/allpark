import { execFileSync } from "node:child_process";
import pg from "pg";

// Runs once before all test files: rebuild the *test* database from migrations.
// Drops the public schema and runs `migrate deploy` (Prisma 7 guards `migrate reset`).
export default async function setup() {
  try {
    process.loadEnvFile();
  } catch {}
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (run npm run setup:worktree)");
  if (url === process.env.DATABASE_URL)
    throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");
  console.log(`[test db] rebuilding ${new URL(url).pathname.slice(1)}`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();

  execFileSync("npx prisma migrate deploy", {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: url },
  });
}
