import { IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { getMonthlyAgreement } from "@/server/monthly/service";

export const GET = route(
  { auth: "user", params: IdParams },
  async ({ user, params }) => {
    const result = await getMonthlyAgreement(user, params.id);
    return Response.json(result, { status: 200 });
  },
);
