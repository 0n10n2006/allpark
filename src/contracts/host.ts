import { z } from "zod";
import { PayoutStatus } from "../generated/prisma/enums";
import { IsoDateTime, Money, Uuid, page } from "./common";

// FR-06. Figures come from the ledger; payoutMode is MANUAL by default (plan §2.2).

/** GET /api/host/earnings. Defaults to all time. */
export const HostEarningsQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
});
export type HostEarningsQuery = z.infer<typeof HostEarningsQuery>;

export const HostEarningsResponse = z.object({
  from: IsoDateTime.nullable(),
  to: IsoDateTime.nullable(),
  gross: Money,
  commission: Money,
  refunds: Money,
  /** gross − commission − refunds ± adjustments. */
  hostEarnings: Money,
  paidOut: Money,
  pendingPayout: Money,
  bookingCount: z.number().int().min(0),
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
