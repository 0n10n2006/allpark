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

/**
 * Rate-limit identity for anonymous callers (L3). Assumes one trusted proxy in front of the
 * app: Vercel sets x-real-ip and overwrites x-forwarded-for with the real client. Behind a
 * proxy that appends instead, only the last x-forwarded-for hop was written by the proxy;
 * earlier entries are client-supplied and spoofable, so the first entry is never trusted.
 */
export function clientIp(headers: Headers) {
  return (
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
    "unknown"
  );
}
