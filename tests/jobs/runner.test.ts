import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { testDb, truncateAll } from "../setup/db";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { claimDue, enqueue, runOnce } = await import("@/server/jobs");
const { registerJob } = await import("@/server/jobs/registry");

beforeEach(truncateAll);

describe("durable jobs", () => {
  it("deduplicates enqueue keys", async () => {
    const [a, b] = await Promise.all([
      enqueue("system.noop", {}, { idempotencyKey: "same" }),
      enqueue("system.noop", {}, { idempotencyKey: "same" }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await testDb.job.count()).toBe(1);
  });

  it("does not double-claim concurrent work and waits for future work", async () => {
    await enqueue("system.noop", {});
    await enqueue("system.noop", {}, { runAt: new Date(Date.now() + 60_000) });
    const [left, right] = await Promise.all([claimDue("left", 10), claimDue("right", 10)]);
    expect([...left, ...right]).toHaveLength(1);
    expect(left[0]?.id).not.toBe(right[0]?.id);

    await testDb.job.updateMany({ where: { status: "PENDING" }, data: { runAt: new Date(Date.now() - 1000) } });
    expect(await claimDue("later", 10)).toHaveLength(1);
  });

  it("retries failed work with backoff and dead-letters it at the attempt limit", async () => {
    registerJob("test.always.fails", z.object({}), async () => {
      throw new Error("secret-ish detail that must not be persisted");
    });
    const job = await enqueue("test.always.fails", {}, { maxAttempts: 3 });
    const makeDue = () =>
      testDb.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });

    for (const [attempt, delaySeconds] of [
      [1, 30],
      [2, 60],
    ]) {
      const before = Date.now();
      expect(await runOnce("runner")).toMatchObject({ claimed: 1, retried: 1, dead: 0 });
      const row = await testDb.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(row).toMatchObject({ status: "PENDING", attempts: attempt, lastError: "Job handler failed" });
      const delay = (row.runAt.getTime() - before) / 1000;
      expect(delay).toBeGreaterThan(delaySeconds - 5);
      expect(delay).toBeLessThan(delaySeconds + 5);
      expect((await runOnce("runner")).claimed).toBe(0);
      await makeDue();
    }

    expect(await runOnce("runner")).toMatchObject({ claimed: 1, dead: 1 });
    expect(await testDb.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "DEAD",
      attempts: 3,
    });
  });

  it("dead-letters unknown job types", async () => {
    const job = await enqueue("test.unregistered", {});
    expect(await runOnce("runner")).toMatchObject({ dead: 1 });
    expect(await testDb.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "DEAD",
      lastError: "Unknown job type",
    });
  });

  it("reclaims stale leases", async () => {
    const job = await enqueue("system.noop", {});
    await testDb.job.update({
      where: { id: job.id },
      data: { status: "RUNNING", lockedAt: new Date(Date.now() - 6 * 60_000), lockedBy: "lost" },
    });
    const claimed = await claimDue("replacement", 1);
    expect(claimed.map((row) => row.id)).toEqual([job.id]);
    expect(claimed[0]?.lockedBy).toBe("replacement");
  });
});
