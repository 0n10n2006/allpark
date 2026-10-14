import { PaginationQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { adminListNotifications } from "@/server/admin/service";
import { z } from "zod";

const AdminListNotificationsQuery = PaginationQuery.extend({
  status: z.string().optional(),
});

export const GET = route(
  { auth: "admin", query: AdminListNotificationsQuery },
  async ({ query }) => {
    return Response.json(await adminListNotifications(query));
  },
);
