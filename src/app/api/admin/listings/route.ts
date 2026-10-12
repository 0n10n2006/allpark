import { AdminListListingsQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { adminListListings } from "@/server/admin/service";

export const GET = route({ auth: "admin", query: AdminListListingsQuery }, async ({ query }) => {
  return Response.json(await adminListListings(query));
});
