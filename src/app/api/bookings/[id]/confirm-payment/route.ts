import { ConfirmPaymentBody, IdParams } from "@/contracts";
import { getBooking } from "@/server/bookings/service";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";
import { getPaymentProvider, notConfigured } from "@/server/payments/provider";
import { confirmFromCallback } from "@/server/payments/service";

// 200 with the booking once settled; 202 with the (still pending) booking while the
// provider hasn't captured yet: the client polls GET /api/bookings/:id.
export const POST = route(
  {
    auth: "user",
    params: IdParams,
    body: ConfirmPaymentBody,
    rateLimit: { name: "payments.confirm", limit: 20, windowSeconds: 60 },
  },
  ({ req, user, params, body }) =>
    withIdempotency(req, user.id, async () => {
      const provider = getPaymentProvider();
      if (!provider) return notConfigured();
      const settled = await confirmFromCallback(provider, user, params.id, body);
      return Response.json(await getBooking(params.id, user), { status: settled ? 200 : 202 });
    }),
);
