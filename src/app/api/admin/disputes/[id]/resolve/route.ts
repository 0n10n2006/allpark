import { AdminResolveDisputeBody, IdParams } from "@/contracts";
import { resolveDispute } from "@/server/disputes/service";
import { route } from "@/server/http/route";

export const POST = route(
  { auth: "admin", params: IdParams, body: AdminResolveDisputeBody },
  async ({ user, params, body }) => Response.json(await resolveDispute(params.id, user, body)),
);
