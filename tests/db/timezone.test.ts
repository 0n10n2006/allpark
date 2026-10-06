import { afterAll, expect, test } from "vitest";
import { testDb, truncateAll } from "../setup/db";

afterAll(() => testDb.$disconnect());

// Regression: a non-UTC server TimeZone shifted every Prisma-written timestamptz.
test("Prisma-written timestamps round-trip as the same instant", async () => {
  await truncateAll();
  const expires = new Date("2026-10-16T10:00:00.000Z");
  await testDb.verificationToken.create({ data: { identifier: "tz", token: "tz", expires } });
  const [row] = await testDb.$queryRaw<{ epoch: number }[]>`
    SELECT extract(epoch FROM expires)::float8 AS epoch FROM "VerificationToken" WHERE token = 'tz'`;
  expect(row.epoch * 1000).toBe(expires.getTime());
});
