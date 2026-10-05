import { z } from "zod";
import { IsoDateTime } from "./common";
import { BookingDetail } from "./bookings";
import { Quote } from "./quotes";

// FR-07. Timestamps come from the server clock, never from the client.

/** POST /api/bookings/:id/check-in: renter's "Start parking", or host confirmation. */
export const CheckInBody = z
  .strictObject({ note: z.string().trim().max(500).optional() })
  .default({});
export type CheckInBody = z.infer<typeof CheckInBody>;

/** POST /api/bookings/:id/check-out: departure by renter or host. */
export const CheckOutBody = z
  .strictObject({ note: z.string().trim().max(500).optional() })
  .default({});
export type CheckOutBody = z.infer<typeof CheckOutBody>;

/**
 * POST /api/bookings/:id/extend (Idempotency-Key). Fresh availability check, then a
 * quote for the extra time. The extension takes effect only after verified payment
 * when `requiresPayment` is true (FR-07).
 */
export const ExtendBookingBody = z.strictObject({ newEndAt: IsoDateTime });
export type ExtendBookingBody = z.infer<typeof ExtendBookingBody>;
export const ExtendBookingResponse = z.object({
  booking: BookingDetail,
  quote: Quote,
  requiresPayment: z.boolean(),
});
export type ExtendBookingResponse = z.infer<typeof ExtendBookingResponse>;
