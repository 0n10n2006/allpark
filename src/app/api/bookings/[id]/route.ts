import { IdParams } from "@/contracts";
import { getBooking } from "@/server/bookings/service";
import { route } from "@/server/http/route";

export const GET = route({ auth: "user", params: IdParams }, async ({ user, params }) =>
  Response.json(await getBooking(params.id, user)),
);
