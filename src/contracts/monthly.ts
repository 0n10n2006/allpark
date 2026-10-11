import { z } from "zod";
import { BookingStatus, MonthlyAgreementStatus, PaymentStatus } from "../generated/prisma/enums";
import { BookingDetail } from "./bookings";
import { IsoDateTime, Money, Uuid } from "./common";
import { Quote } from "./quotes";

/**
 * POST /api/monthly/:id/renew (Idempotency-Key). FR-09: explicit renter action only.
 * Revalidates the listing and the next term's availability, then returns a hold for
 * the next term plus its quote. The renter pays through POST /api/payments/order.
 */
export const RenewMonthlyBody = z.strictObject({}).default({});
export type RenewMonthlyBody = z.infer<typeof RenewMonthlyBody>;
export const RenewMonthlyResponse = z.object({
  hold: BookingDetail,
  quote: Quote,
  bookingId: Uuid.optional(),
  quoteId: Uuid.optional(),
});
export type RenewMonthlyResponse = z.infer<typeof RenewMonthlyResponse>;

/**
 * POST /api/monthly/:id/cancel
 * Gives notice to end the monthly agreement at current termEnd.
 */
export const CancelMonthlyBody = z.strictObject({
  reason: z.string().trim().min(1, "Reason is required").max(500),
});
export type CancelMonthlyBody = z.infer<typeof CancelMonthlyBody>;
export const CancelMonthlyResponse = z.object({
  success: z.boolean(),
  agreementId: Uuid,
  status: z.enum(MonthlyAgreementStatus),
  endedAt: IsoDateTime,
});
export type CancelMonthlyResponse = z.infer<typeof CancelMonthlyResponse>;

/**
 * GET /api/monthly/:id
 * Agreement detail, past terms (bookings), payments, and notices.
 */
export const MonthlyAgreementTerm = z.object({
  id: Uuid,
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  status: z.enum(BookingStatus),
  total: Money,
  payments: z.array(
    z.object({
      id: Uuid,
      amount: Money,
      status: z.enum(PaymentStatus),
      createdAt: IsoDateTime,
    }),
  ),
});
export type MonthlyAgreementTerm = z.infer<typeof MonthlyAgreementTerm>;

export const MonthlyAgreementNotice = z.object({
  id: Uuid,
  action: z.string(),
  reason: z.string().nullable(),
  createdAt: IsoDateTime,
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type MonthlyAgreementNotice = z.infer<typeof MonthlyAgreementNotice>;

export const MonthlyAgreementDetail = z.object({
  id: Uuid,
  listingId: Uuid,
  renterId: Uuid,
  vehicleId: Uuid.nullable(),
  status: z.enum(MonthlyAgreementStatus),
  startAt: IsoDateTime,
  currentTermStartAt: IsoDateTime,
  currentTermEndAt: IsoDateTime,
  noticePeriodDays: z.number().int(),
  noticeGivenAt: IsoDateTime.nullable(),
  renewalReminderAt: IsoDateTime.nullable(),
  renewalDueAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
  monthlyRate: Money,
  listing: z.object({
    id: Uuid,
    title: z.string(),
    locality: z.string(),
    address: z.string().nullable(),
  }),
  terms: z.array(MonthlyAgreementTerm),
  notices: z.array(MonthlyAgreementNotice),
  createdAt: IsoDateTime,
});
export type MonthlyAgreementDetail = z.infer<typeof MonthlyAgreementDetail>;

