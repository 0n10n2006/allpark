import type { CreateQuoteBody, Quote, QuoteLineItem } from "@/contracts";
import { Uuid } from "@/contracts";
import { cancellationText, getActivePolicy, overstayText } from "@/config/policy";
import type { PriceQuote, RentalType } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { priceFor } from "./calc";

const QUOTE_TTL_MS = 15 * 60_000;
/** Slack for clock skew and form-fill time on "start now" requests. */
const PAST_START_SLACK_MS = 5 * 60_000;

export async function createQuote(user: CurrentUser, input: CreateQuoteBody): Promise<Quote> {
  const now = new Date();
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  if (startAt.getTime() < now.getTime() - PAST_START_SLACK_MS)
    throw new HttpError("unprocessable", "Start time is in the past");

  const listing = await db.listing.findUnique({ where: { id: input.listingId } });
  // Unpublished listings look exactly like missing ones.
  if (!listing || listing.status !== "PUBLISHED")
    throw new HttpError("not_found", "Listing not found");
  if (input.vehicleId) {
    const vehicle = await db.vehicle.findUnique({ where: { id: input.vehicleId } });
    if (!vehicle || vehicle.userId !== user.id || vehicle.deletedAt)
      throw new HttpError("not_found", "Vehicle not found");
  }

  const policy = await getActivePolicy(now);
  const price = priceFor(listing, input.rentalType, startAt, endAt, policy);
  const quote = await db.priceQuote.create({
    data: {
      renterId: user.id,
      listingId: listing.id,
      vehicleId: input.vehicleId ?? null,
      rentalType: input.rentalType,
      startAt,
      endAt,
      lineItems: price.lineItems,
      subtotalPaise: price.subtotalPaise,
      renterFeePaise: price.renterFeePaise,
      commissionPaise: price.commissionPaise,
      hostEarningsPaise: price.hostEarningsPaise,
      totalPaise: price.totalPaise,
      currency: "INR",
      policyVersionId: policy.id,
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
    },
  });

  return {
    id: quote.id,
    listingId: quote.listingId,
    vehicleId: quote.vehicleId,
    rentalType: quote.rentalType,
    startAt: quote.startAt.toISOString(),
    endAt: quote.endAt.toISOString(),
    lineItems: quote.lineItems as QuoteLineItem[],
    subtotal: { paise: quote.subtotalPaise, currency: "INR" },
    renterFee: { paise: quote.renterFeePaise, currency: "INR" },
    total: { paise: quote.totalPaise, currency: "INR" },
    policyVersion: policy.version,
    terms: {
      cancellation: cancellationText(policy, listing.cancellationPolicy, input.rentalType),
      overstay: overstayText(policy),
      gracePeriodMinutes: policy.gracePeriodMinutes,
    },
    expiresAt: quote.expiresAt.toISOString(),
  };
}

/**
 * Re-checks a quote before booking (FR-05 AC2). Missing, foreign, expired, or mismatched
 * quotes all fail with 422; the message never reveals whether the quote exists.
 */
export async function validateQuote(
  quoteId: string,
  renterId: string,
  listingId: string,
  rentalType: RentalType,
  interval: { startAt: Date | string; endAt: Date | string },
): Promise<PriceQuote> {
  const invalid = (reason: string) => new HttpError("unprocessable", reason);
  if (!Uuid.safeParse(quoteId).success) throw invalid("Quote not found");
  const quote = await db.priceQuote.findUnique({
    where: { id: quoteId },
    include: { extensionPayments: { select: { id: true }, take: 1 } },
  });
  // M3: an extension quote prices only the delta and is paid by its own Payment; it is
  // never a standalone booking. Same message, so it doesn't reveal what the id is.
  if (!quote || quote.renterId !== renterId || quote.extensionPayments.length)
    throw invalid("Quote not found");
  if (quote.expiresAt.getTime() <= Date.now()) throw invalid("Quote expired");
  if (
    quote.listingId !== listingId ||
    quote.rentalType !== rentalType ||
    quote.startAt.getTime() !== new Date(interval.startAt).getTime() ||
    quote.endAt.getTime() !== new Date(interval.endAt).getTime()
  )
    throw invalid("Quote does not match this booking");
  return quote;
}
