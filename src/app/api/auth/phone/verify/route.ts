import { PhoneOtpVerifyBody } from "@/contracts";
import { sessionCookie, verifyPhoneOtp } from "@/server/auth/phone-otp";
import { getSmsSender, smsNotConfigured } from "@/server/auth/sms";
import { route } from "@/server/http/route";

// FR-01: signed out → signs in (sets the Auth.js session cookie); signed in → verifies the
// number on the caller's account. Codes are single use.
export const POST = route(
  {
    auth: "public",
    body: PhoneOtpVerifyBody,
    rateLimit: { name: "auth.phone.verify", limit: 20, windowSeconds: 600 },
  },
  async ({ user, body }) => {
    if (!getSmsSender()) return smsNotConfigured();
    const { session, ...result } = await verifyPhoneOtp(body.phone, body.code, user);
    return Response.json(result, {
      headers: session ? { "Set-Cookie": sessionCookie(session.token, session.expires) } : {},
    });
  },
);
