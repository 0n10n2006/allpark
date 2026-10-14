import { AdminListPaymentsQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { adminListPayments } from "@/server/admin/service";

export const GET = route({ auth: "admin", query: AdminListPaymentsQuery }, async ({ query }) => {
  return Response.json(await adminListPayments(query));
});
