import { CreatePaymentOrderBody } from "@/contracts";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";
import { notConfigured } from "@/server/payments/provider";
import { createPaymentOrder } from "@/server/payments/service";

export const POST = route(
  {
    auth: "user",
    body: CreatePaymentOrderBody,
    rateLimit: { name: "payments.order", limit: 20, windowSeconds: 60 },
  },
  ({ req, user, body }) =>
    withIdempotency(req, user.id, async () => {
      const order = await createPaymentOrder(user, body.bookingId);
      return order ? Response.json(order, { status: 201 }) : notConfigured();
    }),
);
