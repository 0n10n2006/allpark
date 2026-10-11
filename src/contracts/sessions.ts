import { z } from "zod";
import { IncidentStatus } from "../generated/prisma/enums";
import { IsoDateTime, Uuid } from "./common";
import { BookingDetail } from "./bookings";
import { CreatePaymentOrderResponse } from "./payments";
import { Quote } from "./quotes";

// FR-07. Timestamps come from the server clock, never from the client.

/**
 * POST /api/bookings/:id/check-in: renter's "Start parking", or with `asHost` the
 * listing host confirming the arrival.
 */
export const CheckInBody = z
  .strictObject({ note: z.string().trim().max(500).optional(), asHost: z.boolean().optional() })
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
  /** Checkout order for the extra time; null when nothing is owed. */
  payment: CreatePaymentOrderResponse.nullable(),
});
export type ExtendBookingResponse = z.infer<typeof ExtendBookingResponse>;

/** An overstay or blocked-access incident (FR-08). `reportedById` is null when the system opened it. */
export const OverstayIncident = z.object({
  id: Uuid,
  bookingId: Uuid,
  reportedById: Uuid.nullable(),
  reportedAt: IsoDateTime,
  evidenceUrls: z.array(z.url()),
  status: z.enum(IncidentStatus),
  resolution: z.string().nullable(),
  resolvedAt: IsoDateTime.nullable(),
});
export type OverstayIncident = z.infer<typeof OverstayIncident>;

/**
 * POST /api/bookings/:id/incidents: the host reports an overstay or blocked access.
 * Evidence must be our Cloudinary uploads (checked by the handler). Updates the open
 * incident if there is one; no fee is ever charged from this (FR-08).
 */
export const ReportIncidentBody = z.strictObject({
  kind: z.enum(["OVERSTAY", "BLOCKED_ACCESS"]),
  note: z.string().trim().max(2000).optional(),
  evidenceUrls: z.array(z.url()).max(10).default([]),
});
export type ReportIncidentBody = z.infer<typeof ReportIncidentBody>;
