import { AdminVerifyHostBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { adminVerifyHost } from "@/server/admin/service";
import { withIdempotency } from "@/server/http/idempotency";

export const POST = route(
  { auth: "admin", params: IdParams, body: AdminVerifyHostBody },
  async ({ req, user, params, body }) => {
    const handle = async () =>
      Response.json(await adminVerifyHost(user, params.id, body.decision, body.reason));
    if (req.headers.get("idempotency-key")) {
      return withIdempotency(req, user.id, handle);
    }
    return handle();
  },
);
