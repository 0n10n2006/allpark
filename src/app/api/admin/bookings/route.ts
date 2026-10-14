import { AdminListBookingsQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { adminListBookings } from "@/server/admin/service";

export const GET = route(
  { auth: "admin", query: AdminListBookingsQuery },
  async ({ user, query }) => {
    return Response.json(await adminListBookings(user, query));
  },
);
