import { randomUUID } from "node:crypto";
import type { UserRole } from "@/generated/prisma/client";
import { testDb } from "../setup/db";

export const ORIGIN = new URL(process.env.AUTH_URL!).origin;

/** Seeds a user plus an Auth.js database session; returns the Cookie header value. */
export async function seedSession(roles: UserRole[] = ["RENTER"]) {
  const user = await testDb.user.create({ data: { email: `${randomUUID()}@test.local`, roles } });
  const sessionToken = randomUUID();
  await testDb.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3600_000) },
  });
  return { user, cookie: `authjs.session-token=${sessionToken}` };
}

export function req(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    origin?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export const noParams = { params: Promise.resolve({}) };
