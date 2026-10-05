import { db } from "@/server/db";

/**
 * Fixed-window counter in the RateLimit table. One atomic upsert per call, so
 * concurrent requests can't both read a stale count.
 * ponytail: old windows are never deleted; add a sweeper job when the table grows.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const [{ count }] = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count", "updatedAt")
    VALUES (${key}, ${windowStart}, 1, now())
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimit"."count" + 1, "updatedAt" = now()
    RETURNING "count"`;
  const resetAt = new Date(windowStart.getTime() + windowMs);
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt };
}
