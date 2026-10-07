import { TZDate } from "@date-fns/tz";
import { addMonths } from "date-fns";
import type { QuoteLineItem } from "@/contracts";
import type { Listing, RentalType } from "@/generated/prisma/client";
import { APP_TIMEZONE, formatIST } from "@/lib/time";
import { formatINR } from "@/lib/money";
import { HttpError } from "@/server/http/errors";

// FR-05. Pure, integer paise only. Every amount here is computed server-side.

export type PricedListing = Pick<
  Listing,
  "hourlyPaise" | "dailyPaise" | "weeklyPaise" | "monthlyPaise" | "minDurationMinutes"
>;
export type FeePolicy = { commissionBps: number; renterFeeBps: number };

export type Price = {
  lineItems: QuoteLineItem[];
  subtotalPaise: number;
  renterFeePaise: number;
  taxPaise: number;
  totalPaise: number;
  /** Host-side; deducted from host earnings, never shown as a renter line item. */
  commissionPaise: number;
  hostEarningsPaise: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// ponytail: flat 400-day cap keeps loops and int4 columns bounded; make it policy if hosts need longer.
const MAX_DURATION = 400 * DAY;
const MAX_INT4 = 2_147_483_647;

/** round-half-up(amount × bps / 10000), integer math only. */
export function bpsOf(amount: number, bps: number): number {
  return Math.floor((amount * bps + 5000) / 10000);
}

const money = (paise: number) => ({ paise, currency: "INR" as const });
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function unprocessable(message: string): never {
  throw new HttpError("unprocessable", message);
}

function rate(paise: number | null, rentalType: RentalType): number {
  if (paise == null) unprocessable(`This listing does not offer ${rentalType} rentals`);
  return paise;
}

/** Calendar months in IST from startAt until endAt is covered (Jan 31 + 1 month = Feb 28/29). */
function monthsCovering(startAt: Date, endAt: Date): number {
  const start = new TZDate(startAt, APP_TIMEZONE);
  let n = 1;
  while (addMonths(start, n).getTime() < endAt.getTime()) n++;
  return n;
}

function charges(
  listing: PricedListing,
  rentalType: RentalType,
  startAt: Date,
  endAt: Date,
): QuoteLineItem[] {
  const ms = endAt.getTime() - startAt.getTime();
  const charge = (code: string, label: string, paise: number): QuoteLineItem => ({
    code,
    label,
    kind: "charge",
    amount: money(paise),
  });

  switch (rentalType) {
    case "HOURLY": {
      const p = rate(listing.hourlyPaise, rentalType);
      const hours = Math.ceil(ms / HOUR);
      return [charge("hourly", `${plural(hours, "hour")} × ${formatINR(p)}`, hours * p)];
    }
    case "DAILY":
    case "MULTI_DAY": {
      // Per started 24h block.
      const p = rate(listing.dailyPaise, rentalType);
      const days = Math.ceil(ms / DAY);
      return [charge("daily", `${plural(days, "day")} × ${formatINR(p)}`, days * p)];
    }
    case "WEEKLY": {
      const p = rate(listing.weeklyPaise, rentalType);
      const weeks = Math.floor(ms / WEEK);
      const extraDays = Math.ceil((ms - weeks * WEEK) / DAY);
      const items =
        weeks > 0
          ? [charge("weekly", `${plural(weeks, "week")} × ${formatINR(p)}`, weeks * p)]
          : [];
      if (extraDays > 0) {
        // Leftover days at the daily rate, never more than one more week.
        const byDay = listing.dailyPaise == null ? p : extraDays * listing.dailyPaise;
        items.push(
          byDay < p
            ? charge(
                "weekly_extra_days",
                `${plural(extraDays, "extra day")} × ${formatINR(listing.dailyPaise!)}`,
                byDay,
              )
            : charge(
                "weekly_extra_week",
                `${weeks > 0 ? "1 extra week" : "1 week"} (${plural(extraDays, "day")}, capped)`,
                p,
              ),
        );
      }
      return items;
    }
    case "MONTHLY": {
      const p = rate(listing.monthlyPaise, rentalType);
      const months = monthsCovering(startAt, endAt);
      return [
        charge(
          "monthly",
          `${plural(months, "month")} × ${formatINR(p)} from ${formatIST(startAt, "d MMM yyyy")}`,
          months * p,
        ),
      ];
    }
  }
}

export function priceFor(
  listing: PricedListing,
  rentalType: RentalType,
  startAt: Date,
  endAt: Date,
  fees: FeePolicy,
): Price {
  const ms = endAt.getTime() - startAt.getTime();
  if (!(ms > 0)) unprocessable("endAt must be after startAt");
  if (ms > MAX_DURATION) unprocessable("Booking is too long");
  // A short request is rejected, not silently billed up to the minimum.
  if (ms < listing.minDurationMinutes * 60_000)
    unprocessable(`Minimum duration is ${listing.minDurationMinutes} minutes`);

  const lineItems = charges(listing, rentalType, startAt, endAt);
  const subtotalPaise = lineItems.reduce((s, i) => s + i.amount.paise, 0);
  const commissionPaise = bpsOf(subtotalPaise, fees.commissionBps);
  const renterFeePaise = bpsOf(subtotalPaise, fees.renterFeeBps);
  // TODO(launch): tax treatment (GST on commission and/or renter charges) is an open
  // launch decision (PRD FR-05); 0 until approved.
  const taxPaise = 0;
  const totalPaise = subtotalPaise + renterFeePaise + taxPaise;
  if (totalPaise > MAX_INT4) unprocessable("Booking total is too large");

  lineItems.push(
    { code: "renter_fee", label: "Service fee", kind: "fee", amount: money(renterFeePaise) },
    { code: "tax", label: "Taxes", kind: "tax", amount: money(taxPaise) },
  );
  return {
    lineItems,
    subtotalPaise,
    renterFeePaise,
    taxPaise,
    totalPaise,
    commissionPaise,
    hostEarningsPaise: subtotalPaise - commissionPaise,
  };
}
