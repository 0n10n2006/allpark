import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

// FR-02/FR-04. Weekly rules are wall-clock minutes in Asia/Kolkata, half-open
// [startMinute, endMinute); weekday 0 = Sunday. Exceptions are UTC [startAt, endAt).

export const AvailabilityRule = z.object({
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
});
export type AvailabilityRule = z.infer<typeof AvailabilityRule>;

export const AvailabilityException = z.object({
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  /** true = blackout; false = extra open hours outside the weekly rules. */
  unavailable: z.boolean(),
  reason: z.string().max(200).nullable().optional(),
});
export type AvailabilityException = z.infer<typeof AvailabilityException>;

/** GET /api/listings/:id/availability. Defaults to the next 14 days. */
export const GetAvailabilityQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
});
export type GetAvailabilityQuery = z.infer<typeof GetAvailabilityQuery>;

/** Busy intervals carry no booking or renter details, so this is safe to show publicly. */
export const GetAvailabilityResponse = z.object({
  listingId: Uuid,
  timezone: z.literal("Asia/Kolkata"),
  rules: z.array(AvailabilityRule),
  exceptions: z.array(AvailabilityException),
  busy: z.array(z.object({ startAt: IsoDateTime, endAt: IsoDateTime })),
});
export type GetAvailabilityResponse = z.infer<typeof GetAvailabilityResponse>;

/** POST /api/listings/:id/availability. Replaces the full rule and exception sets (owner only). */
export const UpdateAvailabilityBody = z.strictObject({
  rules: z.array(AvailabilityRule).max(100),
  exceptions: z.array(AvailabilityException).max(500),
});
export type UpdateAvailabilityBody = z.infer<typeof UpdateAvailabilityBody>;
