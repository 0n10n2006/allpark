import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import pg from "pg";

// Playwright doesn't load .env; the dev server reads the same DATABASE_URL.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {}
}

export type SignInOptions = {
  roles?: string[];
  hostVerificationStatus?: string;
  name?: string;
  email?: string;
  baseURL?: string;
};

/**
 * Signs a fresh user in by inserting a User + Auth.js database Session row and
 * setting the session cookie on the context. `baseURL` must match AUTH_URL's origin.
 */
export async function signIn(
  context: BrowserContext,
  baseURLOrRolesOrOptions?: string | string[] | SignInOptions,
  statusOrOptions?: string | SignInOptions,
): Promise<{ userId: string; id: string }> {
  let baseURL: string | undefined = undefined;
  let roles: string[] = ["RENTER"];
  let hostVerificationStatus = "NOT_STARTED";
  let name = "E2E User";
  let email: string | undefined = undefined;

  if (typeof baseURLOrRolesOrOptions === "string") {
    baseURL = baseURLOrRolesOrOptions;
    if (typeof statusOrOptions === "object" && statusOrOptions !== null) {
      if (statusOrOptions.roles) roles = statusOrOptions.roles;
      if (statusOrOptions.hostVerificationStatus)
        hostVerificationStatus = statusOrOptions.hostVerificationStatus;
      if (statusOrOptions.name) name = statusOrOptions.name;
      if (statusOrOptions.email) email = statusOrOptions.email;
    }
  } else if (Array.isArray(baseURLOrRolesOrOptions)) {
    roles = baseURLOrRolesOrOptions;
    if (typeof statusOrOptions === "string") {
      hostVerificationStatus = statusOrOptions;
    } else if (typeof statusOrOptions === "object" && statusOrOptions !== null) {
      if (statusOrOptions.hostVerificationStatus)
        hostVerificationStatus = statusOrOptions.hostVerificationStatus;
      if (statusOrOptions.name) name = statusOrOptions.name;
      if (statusOrOptions.email) email = statusOrOptions.email;
      if (statusOrOptions.baseURL) baseURL = statusOrOptions.baseURL;
    }
  } else if (typeof baseURLOrRolesOrOptions === "object" && baseURLOrRolesOrOptions !== null) {
    if (baseURLOrRolesOrOptions.roles) roles = baseURLOrRolesOrOptions.roles;
    if (baseURLOrRolesOrOptions.hostVerificationStatus)
      hostVerificationStatus = baseURLOrRolesOrOptions.hostVerificationStatus;
    if (baseURLOrRolesOrOptions.name) name = baseURLOrRolesOrOptions.name;
    if (baseURLOrRolesOrOptions.email) email = baseURLOrRolesOrOptions.email;
    if (baseURLOrRolesOrOptions.baseURL) baseURL = baseURLOrRolesOrOptions.baseURL;
  }

  const defaultBaseURL = `http://localhost:${process.env.E2E_PORT ?? 3000}`;
  const targetURL = baseURL ?? defaultBaseURL;

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const userId = randomUUID();
    const token = randomUUID();
    const userEmail = email ?? `e2e-${userId}@test.local`;

    await client.query(
      `INSERT INTO "User" (id, email, name, roles, "hostVerificationStatus", "updatedAt")
       VALUES ($1, $2, $3, $4::"UserRole"[], $5::"HostVerificationStatus", now())`,
      [userId, userEmail, name, roles, hostVerificationStatus],
    );
    await client.query(
      `INSERT INTO "Session" ("sessionToken", "userId", expires, "updatedAt")
       VALUES ($1, $2, now() + interval '1 hour', now())`,
      [token, userId],
    );
    await context.addCookies([
      {
        name: "authjs.session-token",
        value: token,
        url: targetURL,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    return { userId, id: userId };
  } finally {
    await client.end();
  }
}
