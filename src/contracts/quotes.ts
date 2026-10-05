import { z } from "zod";
import { RentalType } from "../generated/prisma/enums";
import { IsoDateTime, Money, Uuid } from "./common";

// FR-05/FR-08. The server computes every amount. The request carries only what is
// being priced; never an amount, commission, hostId, or status.

/** One row of the breakdown. `discount` rows are subtracted; all other kinds add. */
export const QuoteLineItem = z.object({
  code: z.string(),
  label: z.string(),
  kind: z.enum(["charge", "discount", "fee", "tax"]),
  amount: Money,
});
export type QuoteLineItem = z.infer<typeof QuoteLineItem>;

/** Terms shown before payment (FR-05, FR-08, FR-10). */
export const QuoteTerms = z.object({
  cancellation: z.string(),
  overstay: z.string(),
  gracePeriodMinutes: z.number().int().min(0),
});
export type QuoteTerms = z.infer<typeof QuoteTerms>;

export const Quote = z.object({
  id: Uuid,
  listingId: Uuid,
  vehicleId: Uuid.nullable(),
  rentalType: z.enum(RentalType),
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  lineItems: z.array(QuoteLineItem),
  subtotal: Money,
  renterFee: Money,
  total: Money,
  policyVersion: z.number().int().positive(),
  terms: QuoteTerms,
  /** Re-validated before booking; an expired quote is rejected. */
  expiresAt: IsoDateTime,
});
export type Quote = z.infer<typeof Quote>;

/** POST /api/quotes */
export const CreateQuoteBody = z.strictObject({
  listingId: Uuid,
  rentalType: z.enum(RentalType),
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  vehicleId: Uuid.optional(),
});
export type CreateQuoteBody = z.infer<typeof CreateQuoteBody>;
