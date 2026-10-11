import { IdParams, RenewMonthlyBody } from "@/contracts";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";
import { renewMonthly } from "@/server/monthly/service";

export const POST = route(
  { auth: "user", params: IdParams, body: RenewMonthlyBody },
  ({ req, user, params }) =>
    withIdempotency(req, user.id, async () => {
      const result = await renewMonthly(user, params.id, req.headers.get("idempotency-key")!);
      return Response.json(result, { status: 200 });
    }),
);
