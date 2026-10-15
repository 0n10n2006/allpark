import { AdminRetryJobBody, IdParams } from "@/contracts";
import { adminRetryJob } from "@/server/admin/retry";
import { route } from "@/server/http/route";

export const POST = route(
  { auth: "admin", params: IdParams, body: AdminRetryJobBody },
  async ({ user, params, body }) => {
    return Response.json(await adminRetryJob(user, params.id, body));
  },
);
