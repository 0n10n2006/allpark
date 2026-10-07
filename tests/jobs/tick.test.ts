import { beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll } from "../setup/db";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { POST } = await import("@/app/api/cron/tick/route");
const { enqueue } = await import("@/server/jobs");

beforeEach(truncateAll);

const tick = (authorization?: string) =>
  POST(
    new Request("http://localhost/api/cron/tick", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }),
  );

describe("POST /api/cron/tick", () => {
  it("rejects a missing or wrong secret without running jobs", async () => {
    await enqueue("system.noop", {});
    expect((await tick()).status).toBe(401);
    expect((await tick("Bearer wrong")).status).toBe(401);
    expect(await testDb.job.count({ where: { status: "PENDING" } })).toBe(1);
  });

  it("processes due jobs with the secret", async () => {
    await enqueue("system.noop", {});
    await enqueue("system.noop", {});
    const response = await tick(`Bearer ${process.env.CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claimed: 2, succeeded: 2, retried: 0, dead: 0 });
    expect(await testDb.job.count({ where: { status: "SUCCEEDED" } })).toBe(2);
  });
});
