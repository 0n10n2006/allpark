import { z } from "zod";
import { BookingDetail } from "./bookings";
import { Quote } from "./quotes";

/**
 * POST /api/monthly/:id/renew (Idempotency-Key). FR-09: explicit renter action only.
 * Revalidates the listing and the next term's availability, then returns a hold for
 * the next term plus its quote. The renter pays through POST /api/payments/order.
 */
export const RenewMonthlyBody = z.strictObject({});
export const RenewMonthlyResponse = z.object({ hold: BookingDetail, quote: Quote });
export type RenewMonthlyResponse = z.infer<typeof RenewMonthlyResponse>;
