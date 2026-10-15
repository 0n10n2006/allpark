import { AdminRetryNotificationBody, IdParams } from "@/contracts";
import { adminRetryNotification } from "@/server/admin/retry";
import { route } from "@/server/http/route";

export const POST = route(
  { auth: "admin", params: IdParams, body: AdminRetryNotificationBody },
  async ({ user, params, body }) => {
    return Response.json(await adminRetryNotification(user, params.id, body));
  },
);
