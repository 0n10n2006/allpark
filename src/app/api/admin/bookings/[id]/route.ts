import { IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { adminGetBookingDetail } from "@/server/admin/service";

export const GET = route({ auth: "admin", params: IdParams }, async ({ user, params }) => {
  return Response.json(await adminGetBookingDetail(params.id, user));
});
