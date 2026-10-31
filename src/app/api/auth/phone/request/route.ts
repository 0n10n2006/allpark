import { PhoneOtpRequestBody } from "@/contracts";
import { requestPhoneOtp } from "@/server/auth/phone-otp";
import { getSmsSender, smsNotConfigured } from "@/server/auth/sms";
import { clientIp } from "@/server/http/rate-limit";
import { route } from "@/server/http/route";

// FR-01: texts a one-time code. Same 200 whether or not the number has an account.
export const POST = route(
  {
    auth: "public",
    body: PhoneOtpRequestBody,
    rateLimit: { name: "auth.phone.request", limit: 10, windowSeconds: 600 },
  },
  async ({ req, body }) => {
    const sender = getSmsSender();
    if (!sender) return smsNotConfigured();
    return Response.json(await requestPhoneOtp(body.phone, clientIp(req.headers), sender));
  },
);
