import { CancelBookingBody, IdParams } from "@/contracts";
import { cancelBooking } from "@/server/cancellations/service";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";

export const POST = route(
  { auth: "user", params: IdParams, body: CancelBookingBody },
  ({ req, user, params, body }) =>
    withIdempotency(req, user.id, async () =>
      Response.json(await cancelBooking(params.id, user, body.reason)),
    ),
);
