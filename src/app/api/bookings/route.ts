import { CreateBookingBody, ListBookingsQuery } from "@/contracts";
import { listBookings } from "@/server/bookings/service";
import { route } from "@/server/http/route";
import { notImplemented } from "../_lib/not-implemented";

export const GET = route({ auth: "user", query: ListBookingsQuery }, async ({ user, query }) =>
  Response.json(await listBookings(user, query)),
);
// Stub (T2.0). Confirming against a hold happens with payment (T4.1).
export const POST = route({ auth: "user", body: CreateBookingBody }, notImplemented);
