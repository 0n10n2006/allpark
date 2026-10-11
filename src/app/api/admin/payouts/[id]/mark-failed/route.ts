import { AdminMarkPayoutFailedBody, IdParams } from "@/contracts";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";
import { markPayoutFailed } from "@/server/payouts/service";

export const POST = route(
  { auth: "admin", params: IdParams, body: AdminMarkPayoutFailedBody },
  ({ req, user, params, body }) =>
    withIdempotency(req, user.id, async () =>
      Response.json(await markPayoutFailed(user, params.id, body.reason)),
    ),
);
