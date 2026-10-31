import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { PhoneOtpVerifyResponse } from "@/contracts";
import type { CurrentUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { rateLimit } from "@/server/http/rate-limit";
import type { SmsSender } from "./sms";

/**
 * Phone one-time codes (FR-01). Codes live hashed in Auth.js's VerificationToken table under
 * identifier "phone:<E.164>", so no schema change is needed and email links are unaffected.
 * Sign-in creates an Auth.js database session directly; getCurrentUser reads it like any other.
 */
export const OTP_TTL_SECONDS = 10 * 60;
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600; // Auth.js default
const SEND_PER_PHONE_PER_HOUR = 5;
const SEND_PER_IP_PER_HOUR = 20;
const VERIFY_ATTEMPTS_PER_CODE_WINDOW = 5;

const identifier = (phone: string) => `phone:${phone}`;

function hashCode(phone: string, code: string) {
  return createHmac("sha256", process.env.AUTH_SECRET!).update(`${phone}:${code}`).digest("hex");
}

/**
 * Sends a fresh 6-digit code, replacing any earlier one. Over the send caps the SMS is silently
 * skipped so the response never differs (no account or throttling oracle), like email links.
 */
export async function requestPhoneOtp(phone: string, ip: string, sender: SmsSender) {
  const [byPhone, byIp] = await Promise.all([
    rateLimit(`otp:${phone}`, SEND_PER_PHONE_PER_HOUR, 3600),
    rateLimit(`otp.ip:${ip}`, SEND_PER_IP_PER_HOUR, 3600),
  ]);
  if (byPhone.ok && byIp.ok) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.$transaction([
      db.verificationToken.deleteMany({ where: { identifier: identifier(phone) } }),
      db.verificationToken.create({
        data: {
          identifier: identifier(phone),
          token: hashCode(phone, code),
          expires: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        },
      }),
    ]);
    await sender.send(
      phone,
      `${code} is your ParkShare code. It expires in ${OTP_TTL_SECONDS / 60} minutes. Don't share it.`,
    );
  }
  return { sent: true as const, expiresInSeconds: OTP_TTL_SECONDS };
}

/** Single use: a correct code is consumed; too many wrong guesses burn the code. */
async function consumeCode(phone: string, code: string) {
  const attempts = await rateLimit(
    `otp.verify:${phone}`,
    VERIFY_ATTEMPTS_PER_CODE_WINDOW,
    OTP_TTL_SECONDS,
  );
  if (!attempts.ok) {
    await db.verificationToken.deleteMany({ where: { identifier: identifier(phone) } });
    throw new HttpError("rate_limited", "Too many attempts. Request a new code.");
  }
  const stored = await db.verificationToken.findFirst({
    where: { identifier: identifier(phone), expires: { gt: new Date() } },
  });
  const expected = Buffer.from(hashCode(phone, code), "hex");
  const ok =
    stored !== null &&
    stored.token.length === expected.length * 2 &&
    timingSafeEqual(Buffer.from(stored.token, "hex"), expected);
  if (!ok)
    throw new HttpError("unprocessable", "That code is wrong or has expired", [
      { path: ["code"], message: "Wrong or expired code" },
    ]);
  // deleteMany's count makes concurrent double-submits of one code resolve to a single winner.
  const { count } = await db.verificationToken.deleteMany({
    where: { identifier: identifier(phone), token: stored.token },
  });
  if (count === 0)
    throw new HttpError("unprocessable", "That code is wrong or has expired", [
      { path: ["code"], message: "Wrong or expired code" },
    ]);
}

export type VerifyOutcome = PhoneOtpVerifyResponse & {
  session?: { token: string; expires: Date };
};

/**
 * Verifies the code. Signed in: the number is attached to the caller's account (unless another
 * account has already verified it). Signed out: signs in to the account that verified this number,
 * or creates one. A number someone merely typed into their profile unverified is never a login
 * key: proving the code takes it over from that account.
 */
export async function verifyPhoneOtp(
  phone: string,
  code: string,
  current: CurrentUser | null,
): Promise<VerifyOutcome> {
  await consumeCode(phone, code);
  const now = new Date();

  return db.$transaction(async (tx) => {
    const holder = await tx.user.findUnique({
      where: { phone },
      select: { id: true, phoneVerifiedAt: true },
    });
    const verifiedHolder = holder?.phoneVerifiedAt ? holder : null;
    // Release an unverified claim held by an account other than the one we're about to use.
    const target = current?.id ?? verifiedHolder?.id;
    if (holder && !holder.phoneVerifiedAt && holder.id !== target) {
      await tx.user.update({ where: { id: holder.id }, data: { phone: null } });
    }

    if (current) {
      if (verifiedHolder && verifiedHolder.id !== current.id)
        throw new HttpError("conflict", "This number is verified on another account", {
          reason: "phone_in_use",
        });
      await tx.user.update({
        where: { id: current.id },
        data: { phone, phoneVerifiedAt: verifiedHolder?.phoneVerifiedAt ?? now },
      });
      await tx.auditLog.create({
        data: {
          actorId: current.id,
          action: "user.phone_verified",
          targetType: "User",
          targetId: current.id,
        },
      });
      return { userId: current.id, result: "verified" as const, isNewUser: false };
    }

    const user =
      verifiedHolder ??
      (await tx.user.create({ data: { phone, phoneVerifiedAt: now }, select: { id: true } }));
    const session = {
      token: randomBytes(32).toString("hex"),
      expires: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
    };
    await tx.session.create({
      data: { sessionToken: session.token, userId: user.id, expires: session.expires },
    });
    return {
      userId: user.id,
      result: "signed_in" as const,
      isNewUser: verifiedHolder === null,
      session,
    };
  });
}

/** Auth.js's cookie name and flags, so sign-out and getCurrentUser treat it like an email session. */
export function sessionCookie(token: string, expires: Date) {
  const secure = new URL(process.env.AUTH_URL!).protocol === "https:";
  const name = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  return [
    `${name}=${token}`,
    "Path=/",
    `Expires=${expires.toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
