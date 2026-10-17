import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { HostVerificationStatus, UserRole } from "@/generated/prisma/client";
import { db } from "@/server/db";

/**
 * Demo Mode helper.
 *
 * PRINCIPLE (PRD Appendix A):
 * Never use mock payment success in production paths.
 * Active ONLY when DEMO_MODE=1 AND NODE_ENV !== "production".
 * Enforced in this single place across the application.
 */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1" && process.env.NODE_ENV !== "production";
}

export type DemoAccount = {
  key: string;
  email: string;
  name: string;
  fullName: string;
  roleLabel: string;
  description: string;
  roles: UserRole[];
  hostVerificationStatus?: HostVerificationStatus;
};

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: "riya",
    email: "riya@parkshare.local",
    name: "Riya",
    fullName: "Riya Sen",
    roleLabel: "Renter",
    description: "Explore listings, book slots, simulate payments, extend bookings, report issues.",
    roles: ["RENTER"],
  },
  {
    key: "harsh",
    email: "harsh@parkshare.local",
    name: "Harsh",
    fullName: "Harsh Vardhan",
    roleLabel: "Verified Host",
    description: "Host of ~30 Pune parking locations, manages availability rules, tracks earnings.",
    roles: ["HOST", "RENTER"],
    hostVerificationStatus: "VERIFIED",
  },
  {
    key: "newhost",
    email: "newhost@parkshare.local",
    name: "New host",
    fullName: "Naveen Host",
    roleLabel: "Unverified Host",
    description: "Newly registered host with pending verification; can draft listings but not publish.",
    roles: ["HOST", "RENTER"],
    hostVerificationStatus: "PENDING",
  },
  {
    key: "asha",
    email: "asha@parkshare.local",
    name: "Asha",
    fullName: "Asha Sharma",
    roleLabel: "Admin",
    description: "Review hosts, moderate listings & photos, resolve disputes, approve payouts.",
    roles: ["ADMIN", "RENTER"],
  },
] as const;

/**
 * Server-side creation of an Auth.js database session for a demo user.
 * Sets the session cookie on the current request/response context.
 */
export async function createDemoSession(userEmail: string): Promise<{ sessionToken: string; userId: string }> {
  if (!isDemoMode()) {
    throw new Error("Demo session creation is only allowed in demo mode");
  }

  const account = DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === userEmail.toLowerCase());
  let user = await db.user.findUnique({
    where: { email: userEmail.toLowerCase() },
  });

  if (!user && account) {
    const now = new Date();
    user = await db.user.create({
      data: {
        email: account.email,
        name: account.fullName,
        roles: [...account.roles],
        hostVerificationStatus: account.hostVerificationStatus ?? "NOT_STARTED",
        emailVerified: now,
        phoneVerifiedAt: now,
        payoutOnboardedAt: account.hostVerificationStatus === "VERIFIED" ? now : null,
      },
    });
  }

  if (!user) {
    throw new Error(`User with email ${userEmail} not found`);
  }

  const sessionToken = randomUUID();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await db.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires,
    },
  });

  const isSecure = process.env.AUTH_URL?.startsWith("https://") ?? false;
  const cookieJar = await cookies();
  const cookieName = isSecure ? "__Secure-authjs.session-token" : "authjs.session-token";

  cookieJar.set(cookieName, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecure,
    expires,
  });

  if (isSecure) {
    cookieJar.set("authjs.session-token", sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
      expires,
    });
  }

  return { sessionToken, userId: user.id };
}
