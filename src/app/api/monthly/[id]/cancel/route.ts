import { CancelMonthlyBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { cancelMonthly } from "@/server/monthly/service";

export const POST = route(
  { auth: "user", params: IdParams, body: CancelMonthlyBody },
  async ({ user, params, body }) => {
    const result = await cancelMonthly(user, params.id, body.reason);
    return Response.json(result, { status: 200 });
  },
);
