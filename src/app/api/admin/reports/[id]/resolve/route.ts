import { AdminResolveReportBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { resolveReport } from "@/server/reports/service";

// POST /api/admin/reports/:id/resolve
export const POST = route(
  { auth: "admin", params: IdParams, body: AdminResolveReportBody },
  async ({ user, params, body }) => {
    const res = await resolveReport(user, params.id, body);
    return Response.json(res);
  },
);
