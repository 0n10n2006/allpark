import { AdminListDisputesQuery } from "@/contracts";
import { adminListDisputes } from "@/server/disputes/service";
import { route } from "@/server/http/route";

export const GET = route(
  { auth: "admin", query: AdminListDisputesQuery },
  async ({ user, query }) => Response.json(await adminListDisputes(user, query)),
);
