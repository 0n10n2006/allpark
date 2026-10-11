import { AdminMarkPayoutPaidBody, IdParams } from "@/contracts";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";
import { markPayoutPaid } from "@/server/payouts/service";

export const POST = route(
  { auth: "admin", params: IdParams, body: AdminMarkPayoutPaidBody },
  ({ req, user, params, body }) =>
    withIdempotency(req, user.id, async () =>
      Response.json(await markPayoutPaid(user, params.id, body)),
    ),
);
