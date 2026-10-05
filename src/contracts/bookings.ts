import { z } from "zod";
import {
  BookingStatus,
  MonthlyAgreementStatus,
  PaymentStatus,
  RefundStatus,
  RentalType,
} from "../generated/prisma/enums";
import { IsoDateTime, Money, PaginationQuery, Uuid, page } from "./common";
import { QuoteTerms } from "./quotes";

// FR-04, PRD §5. Booking status, payment status, and refund status are separate
// fields. A hold is a booking in PENDING_PAYMENT with holdExpiresAt.

/**
 * Private location and access details (FR-01 AC4, FR-03, FR-07). Only present on
 * GET /api/bookings/:id for the renter of a confirmed booking, the host, or an admin.
 */
export const BookingAccessDetails = z.object({
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  accessInstructions: z.string().nullable(),
  hostContact: z.object({
    name: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  }),
});
export type BookingAccessDetails = z.infer<typeof BookingAccessDetails>;

/** List row. Never carries access details. */
export const BookingSummary = z.strictObject({
  id: Uuid,
  listing: z.strictObject({
    id: Uuid,
    title: z.string(),
    locality: z.string(),
    photoUrl: z.url().nullable(),
  }),
  rentalType: z.enum(RentalType),
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  status: z.enum(BookingStatus),
  /** Latest payment's status; null before an order exists. */
  paymentStatus: z.enum(PaymentStatus).nullable(),
  /** Latest refund's status; null when no refund exists. */
  refundStatus: z.enum(RefundStatus).nullable(),
  total: Money,
  /** Set while status is PENDING_PAYMENT. Server time decides expiry. */
  holdExpiresAt: IsoDateTime.nullable(),
});
export type BookingSummary = z.infer<typeof BookingSummary>;

export const BookingDetail = z.object({
  ...BookingSummary.shape,
  renterId: Uuid,
  vehicle: z
    .object({ id: Uuid, registration: z.string(), nickname: z.string().nullable() })
    .nullable(),
  subtotal: Money,
  renterFee: Money,
  /** Host and admin only; null for the renter. */
  commission: Money.nullable(),
  hostEarnings: Money.nullable(),
  terms: QuoteTerms,
  /** endAt + grace period; drives the session countdown (FR-07). */
  gracePeriodEndsAt: IsoDateTime,
  checkedInAt: IsoDateTime.nullable(),
  checkedOutAt: IsoDateTime.nullable(),
  cancelledAt: IsoDateTime.nullable(),
  cancellationReason: z.string().nullable(),
  monthlyAgreement: z
    .object({
      id: Uuid,
      status: z.enum(MonthlyAgreementStatus),
      currentTermEndAt: IsoDateTime,
      renewalDueAt: IsoDateTime.nullable(),
    })
    .nullable(),
  /** null unless the viewer is authorized and the booking is confirmed or later. */
  access: BookingAccessDetails.nullable(),
  createdAt: IsoDateTime,
});
export type BookingDetail = z.infer<typeof BookingDetail>;

/** GET /api/bookings: the caller's bookings, as renter (default) or as host. */
export const ListBookingsQuery = PaginationQuery.extend({
  as: z.enum(["renter", "host"]).default("renter"),
  scope: z.enum(["upcoming", "active", "past", "all"]).default("all"),
});
export type ListBookingsQuery = z.infer<typeof ListBookingsQuery>;
export const ListBookingsResponse = page(BookingSummary);
export type ListBookingsResponse = z.infer<typeof ListBookingsResponse>;

/**
 * POST /api/bookings/hold (Idempotency-Key). Listing, interval, vehicle, and price
 * come from the server-side quote; 409 when the slot is taken.
 */
export const CreateHoldBody = z.strictObject({ quoteId: Uuid });
export type CreateHoldBody = z.infer<typeof CreateHoldBody>;

/** POST /api/bookings (Idempotency-Key): proceed with a booking against a valid, unexpired hold. */
export const CreateBookingBody = z.strictObject({ holdId: Uuid });
export type CreateBookingBody = z.infer<typeof CreateBookingBody>;

/** POST /api/bookings/:id/cancel (Idempotency-Key). Refund runs as a separate state machine. */
export const CancelBookingBody = z
  .strictObject({ reason: z.string().trim().max(500).optional() })
  .default({});
export type CancelBookingBody = z.infer<typeof CancelBookingBody>;
