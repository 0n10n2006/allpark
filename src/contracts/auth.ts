import { z } from "zod";
import { Uuid } from "./common";

// FR-01 phone sign-in / verification (decision Q4: behind an SMS-sender interface).

/** Indian mobile, accepted as +91XXXXXXXXXX, 91XXXXXXXXXX, or 10 digits; spaces/dashes ignored. */
export const IndianMobile = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .transform((v) => (/^[6-9]\d{9}$/.test(v) ? `+91${v}` : /^91[6-9]\d{9}$/.test(v) ? `+${v}` : v))
  .pipe(z.string().regex(/^\+91[6-9]\d{9}$/, "Enter an Indian mobile number, e.g. +919812345678"));

/** POST /api/auth/phone/request. */
export const PhoneOtpRequestBody = z.strictObject({ phone: IndianMobile });
export type PhoneOtpRequestBody = z.infer<typeof PhoneOtpRequestBody>;

/** Always the same shape, whether or not a code was actually sent (no account oracle). */
export const PhoneOtpRequestResponse = z.object({
  sent: z.literal(true),
  expiresInSeconds: z.number().int().positive(),
});
export type PhoneOtpRequestResponse = z.infer<typeof PhoneOtpRequestResponse>;

/** POST /api/auth/phone/verify. Signed out: signs in (creating the account if new). Signed in: verifies the number on this account. */
export const PhoneOtpVerifyBody = z.strictObject({
  phone: IndianMobile,
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});
export type PhoneOtpVerifyBody = z.infer<typeof PhoneOtpVerifyBody>;

export const PhoneOtpVerifyResponse = z.object({
  userId: Uuid,
  /** "signed_in": a new session cookie was set. "verified": the number now belongs to the caller's account. */
  result: z.enum(["signed_in", "verified"]),
  isNewUser: z.boolean(),
});
export type PhoneOtpVerifyResponse = z.infer<typeof PhoneOtpVerifyResponse>;
