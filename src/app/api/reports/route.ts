import { CreateReportBody } from "@/contracts";
import { route } from "@/server/http/route";
import { createReport } from "@/server/reports/service";

// POST /api/reports (any signed-in user; rate limited 10/hour)
export const POST = route(
  {
    auth: "user",
    rateLimit: { name: "reports", limit: 10, windowSeconds: 3600 },
    body: CreateReportBody,
  },
  async ({ user, body }) => {
    const res = await createReport(user, body);
    return Response.json(res, { status: 201 });
  },
);
