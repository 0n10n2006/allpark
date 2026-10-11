import { AdminListReportsQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { listReports } from "@/server/reports/service";

// GET /api/admin/reports (admin queue, filters by status/targetType)
export const GET = route(
  { auth: "admin", query: AdminListReportsQuery },
  async ({ user, query }) => {
    const res = await listReports(user, query);
    return Response.json(res);
  },
);
