import { cookies } from "next/headers";
import type { HostVerificationStatus, UserRole } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";

// Auth.js database-session cookie; the __Secure- prefix is used when AUTH_URL is https.
export const SESSION_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"];

const userSelect = {
  id: true,
  name: true,
  email: true,
  image: true,
  roles: true,
  hostVerificationStatus: true,
} as const;

export type CurrentUser = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  roles: UserRole[];
  hostVerificationStatus: HostVerificationStatus;
};

function tokenFromCookieHeader(header: string | null) {
  if (!header) return undefined;
  const jar = new Map(
    header.split(";").map((part) => {
      const i = part.indexOf("=");
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()] as const;
    }),
  );
  return SESSION_COOKIES.map((n) => jar.get(n)).find(Boolean);
}

/**
 * Resolves the signed-in user from the Auth.js session cookie by reading the
 * Session table directly. Pass `req` in route handlers and proxy; omit it in
 * server components and actions (falls back to next/headers).
 * Not calling `auth()` keeps this usable outside a Next request scope (tests).
 */
export async function getCurrentUser(req?: Request): Promise<CurrentUser | null> {
  let token: string | undefined;
  if (req) token = tokenFromCookieHeader(req.headers.get("cookie"));
  else {
    const jar = await cookies();
    token = SESSION_COOKIES.map((n) => jar.get(n)?.value).find(Boolean);
  }
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { sessionToken: token },
    select: { expires: true, user: { select: { ...userSelect, suspendedAt: true } } },
  });
  if (!session || session.expires <= new Date()) return null;
  // Suspended accounts (FR-13) are treated as signed out everywhere, even with a
  // session created after suspension (e.g. a fresh magic link).
  const { suspendedAt, ...user } = session.user;
  return suspendedAt ? null : user;
}

export async function requireUser(req?: Request): Promise<CurrentUser> {
  const user = await getCurrentUser(req);
  if (!user) throw new HttpError("unauthorized", "Sign in required");
  return user;
}

export async function requireRole(role: UserRole, req?: Request): Promise<CurrentUser> {
  const user = await requireUser(req);
  if (!user.roles.includes(role)) throw new HttpError("forbidden", "Forbidden");
  return user;
}

export async function requireVerifiedHost(req?: Request): Promise<CurrentUser> {
  const user = await requireUser(req);
  if (!user.roles.includes("HOST") || user.hostVerificationStatus !== "VERIFIED")
    throw new HttpError("forbidden", "Host verification required");
  return user;
}

/** Owner-only access; admins act through admin routes, not here. */
export function assertOwner(resourceOwnerId: string, user: CurrentUser): void {
  if (resourceOwnerId !== user.id) throw new HttpError("forbidden", "Forbidden");
}
