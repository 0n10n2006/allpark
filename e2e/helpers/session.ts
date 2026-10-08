import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import pg from "pg";

// Playwright doesn't load .env; the dev server reads the same DATABASE_URL.
if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

/**
 * Signs a fresh user in by inserting a User + Auth.js database Session row and
 * setting the session cookie on the context. `baseURL` must match AUTH_URL's origin.
 */
export async function signIn(context: BrowserContext, baseURL: string) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const userId = randomUUID();
    const token = randomUUID();
    await client.query(
      `INSERT INTO "User" (id, email, name, "updatedAt") VALUES ($1, $2, 'E2E User', now())`,
      [userId, `e2e-${userId}@test.local`],
    );
    await client.query(
      `INSERT INTO "Session" ("sessionToken", "userId", expires, "updatedAt")
       VALUES ($1, $2, now() + interval '1 hour', now())`,
      [token, userId],
    );
    await context.addCookies([
      { name: "authjs.session-token", value: token, url: baseURL, httpOnly: true, sameSite: "Lax" },
    ]);
    return { userId };
  } finally {
    await client.end();
  }
}
