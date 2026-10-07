import { CreateHoldBody } from "@/contracts";
import { holdFromQuote } from "@/server/bookings/service";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";

export const POST = route(
  {
    auth: "user",
    body: CreateHoldBody,
    rateLimit: { name: "booking-hold", limit: 30, windowSeconds: 600 },
  },
  ({ req, user, body }) =>
    withIdempotency(req, user.id, async () =>
      Response.json(await holdFromQuote(user, body.quoteId, req.headers.get("idempotency-key")!), {
        status: 201,
      }),
    ),
);
