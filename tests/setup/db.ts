import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Bound to TEST_DATABASE_URL explicitly; never import src/server/db.ts from DB tests.
try {
  process.loadEnvFile();
} catch {}
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set");

export const testDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url, options: "-c TimeZone=UTC" }),
});

/** Empties every application table (keeps _prisma_migrations). */
export async function truncateAll() {
  const rows = await testDb.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await testDb.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
