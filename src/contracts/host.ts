import { z } from "zod";
import { BookingStatus, PayoutStatus } from "../generated/prisma/enums";
import { IsoDateTime, Money, Uuid, page } from "./common";

// FR-06. Figures come from the ledger; payoutMode is MANUAL by default (plan §2.2).

/** GET /api/host/earnings. Defaults to all time. */
export const HostEarningsQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
});
export type HostEarningsQuery = z.infer<typeof HostEarningsQuery>;

/**
 * PENDING: not COMPLETED yet, inside the hold-back window, or a refund is in flight.
 * PAYABLE: can go into a payout. PAID: claimed by a payout (hostPayoutId is set).
 */
export const EarningStatus = z.enum(["PENDING", "PAYABLE", "PAID"]);
export type EarningStatus = z.infer<typeof EarningStatus>;

/** One booking's split. net = gross − commission − hostRefunds. */
export const HostEarningsBooking = z.object({
  bookingId: Uuid,
  listingTitle: z.string(),
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  bookingStatus: z.enum(BookingStatus),
  gross: Money,
  commission: Money,
  /** The host's proportional share of refunds (see src/server/payouts/earnings.ts). */
  hostRefunds: Money,
  net: Money,
  status: EarningStatus,
  hostPayoutId: Uuid.nullable(),
  payoutStatus: z.enum(PayoutStatus).nullable(),
});
export type HostEarningsBooking = z.infer<typeof HostEarningsBooking>;

export const HostEarningsResponse = z.object({
  from: IsoDateTime.nullable(),
  to: IsoDateTime.nullable(),
  gross: Money,
  commission: Money,
  /** The host-borne share of refunds. */
  refunds: Money,
  /** gross − commission − refunds. */
  hostEarnings: Money,
  /** Claimed by a payout (the "paid" bucket). */
  paidOut: Money,
  /** pending + payable. */
  pendingPayout: Money,
  bookingCount: z.number().int().min(0),
  pending: Money,
  payable: Money,
  payoutMode: z.enum(["MANUAL", "AUTO"]),
  bookings: z.array(HostEarningsBooking),
});
export type HostEarningsResponse = z.infer<typeof HostEarningsResponse>;

export const HostPayout = z.object({
  id: Uuid,
  amount: Money,
  status: z.enum(PayoutStatus),
  providerReference: z.string().nullable(),
  failureReason: z.string().nullable(),
  bookingCount: z.number().int().min(0),
  paidAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type HostPayout = z.infer<typeof HostPayout>;

export const ListHostPayoutsResponse = page(HostPayout);
export type ListHostPayoutsResponse = z.infer<typeof ListHostPayoutsResponse>;
