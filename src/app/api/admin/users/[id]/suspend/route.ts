import { AdminSuspendUserBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { adminSuspendUser } from "@/server/admin/service";
import { withIdempotency } from "@/server/http/idempotency";

export const POST = route(
  { auth: "admin", params: IdParams, body: AdminSuspendUserBody },
  async ({ req, user, params, body }) => {
    const handle = async () =>
      Response.json(await adminSuspendUser(user, params.id, body.suspended, body.reason));
    if (req.headers.get("idempotency-key")) {
      return withIdempotency(req, user.id, handle);
    }
    return handle();
  },
);
