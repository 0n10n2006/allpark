import { IdParams } from "@/contracts";
import { adminGetDispute } from "@/server/disputes/service";
import { route } from "@/server/http/route";

export const GET = route({ auth: "admin", params: IdParams }, async ({ user, params }) =>
  Response.json(await adminGetDispute(params.id, user)),
);
