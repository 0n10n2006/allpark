import { AdminListUsersQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { adminListUsers } from "@/server/admin/service";

export const GET = route({ auth: "admin", query: AdminListUsersQuery }, async ({ query }) => {
  return Response.json(await adminListUsers(query));
});
