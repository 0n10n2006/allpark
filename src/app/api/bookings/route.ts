import { CreateBookingBody, ListBookingsQuery } from "@/contracts";
import { bookingFromHold, listBookings } from "@/server/bookings/service";
import { route } from "@/server/http/route";

export const GET = route({ auth: "user", query: ListBookingsQuery }, async ({ user, query }) =>
  Response.json(await listBookings(user, query)),
);

// 200 once a verified payment has confirmed the hold; 202 while the live hold still awaits
// payment (POST /api/payments/order); 409 when it expired or failed. Never confirms on its own
// and writes nothing, so it is safe to repeat and needs no Idempotency-Key.
export const POST = route(
  {
    auth: "user",
    body: CreateBookingBody,
    rateLimit: { name: "booking-create", limit: 30, windowSeconds: 600 },
  },
  async ({ user, body }) => {
    const { booking, settled } = await bookingFromHold(user, body.holdId);
    return Response.json(booking, { status: settled ? 200 : 202 });
  },
);
