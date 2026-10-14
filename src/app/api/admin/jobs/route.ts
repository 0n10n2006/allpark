import { AdminListJobsQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { adminListJobs } from "@/server/admin/service";

export const GET = route({ auth: "admin", query: AdminListJobsQuery }, async ({ query }) => {
  return Response.json(await adminListJobs(query));
});
