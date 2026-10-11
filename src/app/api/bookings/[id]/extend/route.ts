import { ExtendBookingBody, IdParams } from "@/contracts";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";
import { notConfigured } from "@/server/payments/provider";
import { requestExtension } from "@/server/sessions/service";

export const POST = route(
  {
    auth: "user",
    params: IdParams,
    body: ExtendBookingBody,
    rateLimit: { name: "booking-extend", limit: 20, windowSeconds: 600 },
  },
  ({ req, user, params, body }) =>
    withIdempotency(req, user.id, async () => {
      const res = await requestExtension(user, params.id, body.newEndAt);
      // Extra time is owed but Razorpay isn't configured (dev): same 503 as /api/payments/order.
      if (res.requiresPayment && !res.payment) return notConfigured();
      return Response.json(res);
    }),
);
