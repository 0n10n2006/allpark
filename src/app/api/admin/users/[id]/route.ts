import { IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { adminGetUser } from "@/server/admin/service";

export const GET = route({ auth: "admin", params: IdParams }, async ({ params }) => {
  return Response.json(await adminGetUser(params.id));
});
