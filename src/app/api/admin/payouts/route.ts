import { AdminCreatePayoutBody, AdminListPayoutsQuery } from "@/contracts";
import { withIdempotency } from "@/server/http/idempotency";
import { route } from "@/server/http/route";
import { createPayout, listAdminPayouts } from "@/server/payouts/service";

export const GET = route({ auth: "admin", query: AdminListPayoutsQuery }, async ({ query }) =>
  Response.json(await listAdminPayouts(query)),
);

export const POST = route({ auth: "admin", body: AdminCreatePayoutBody }, ({ req, user, body }) =>
  withIdempotency(req, user.id, async () =>
    Response.json(await createPayout(user, body, req.headers.get("idempotency-key")!), {
      status: 201,
    }),
  ),
);
