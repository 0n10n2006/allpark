import { TZDate } from "@date-fns/tz";
import { addMonths } from "date-fns";
import { GetAvailabilityResponse } from "@/contracts";
import { getActivePolicy } from "@/config/policy";
import {
  Prisma,
  type AvailabilityException,
  type AvailabilityRule,
  type Booking,
  type Listing,
  type RentalType,
} from "@/generated/prisma/client";
import { APP_TIMEZONE, startOfDayIST } from "@/lib/time";
import { db } from "@/server/db";
import { errorCode, HttpError } from "@/server/http/errors";
import { enqueue } from "@/server/jobs";
import { validateQuote } from "@/server/pricing/quotes";

// FR-04, plan §2.1. The only module that writes inventory (Booking rows). Postgres's
// booking_no_overlap exclusion constraint is the final arbiter; everything here is the
// friendly pre-check plus the stale-hold expiry the constraint's predicate can't do.

type Tx = Prisma.TransactionClient;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Mirrors the booking_no_overlap predicate in the init migration. */
export const BLOCKING_STATUSES = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "ACTIVE",
  "GRACE_PERIOD",
  "OVERSTAY",
  "DISPUTED",
] as const;
const BLOCKING_SQL = Prisma.raw(BLOCKING_STATUSES.map((s) => `'${s}'`).join(","));

export const EXPIRE_HOLDS_JOB = "bookings.expireHolds";

const unprocessable = (reason: string, message: string) =>
  new HttpError("unprocessable", message, { reason });

export type ScheduledListing = Listing & {
  availabilityRules: AvailabilityRule[];
  exceptions: AvailabilityException[];
};

const OFFERED: Record<RentalType, (l: Listing) => boolean> = {
  HOURLY: (l) => l.hourlyPaise != null,
  DAILY: (l) => l.dailyPaise != null,
  MULTI_DAY: (l) => l.dailyPaise != null,
  WEEKLY: (l) => l.weeklyPaise != null,
  MONTHLY: (l) => l.monthlyPaise != null,
};

/** True when [startAt, endAt) is fully covered by open windows (weekly rules + open exceptions). */
function covered(listing: ScheduledListing, startAt: Date, endAt: Date): boolean {
  const s = startAt.getTime();
  const e = endAt.getTime();
  const windows: [number, number][] = [];
  // IST has no DST, so local days are exactly 24 h apart.
  for (let day = startOfDayIST(startAt).getTime(); day < e; day += DAY) {
    const weekday = new TZDate(day, APP_TIMEZONE).getDay();
    for (const r of listing.availabilityRules)
      if (r.weekday === weekday) windows.push([day + r.startMinute * MIN, day + r.endMinute * MIN]);
  }
  for (const x of listing.exceptions)
    if (!x.unavailable) windows.push([x.startAt.getTime(), x.endAt.getTime()]);
  windows.sort((a, b) => a[0] - b[0]);
  let cursor = s;
  for (const [a, b] of windows) {
    if (a > cursor) break;
    cursor = Math.max(cursor, b);
    if (cursor >= e) return true;
  }
  return cursor >= e;
}

/**
 * Why [startAt, endAt) can't be booked on this listing, ignoring other bookings, or null
 * if it can. Covers status, rental type, minimum duration, weekly hours (every touched
 * IST day must be open; "24x7" is rules 0–1440 on all weekdays), and blackouts.
 * A listing with no rules is never bookable.
 */
export function scheduleProblem(
  listing: ScheduledListing,
  startAt: Date,
  endAt: Date,
  rentalType?: RentalType,
): { reason: string; message: string } | null {
  if (listing.status !== "PUBLISHED")
    return { reason: "listing_unavailable", message: "This listing isn't taking bookings" };
  if (rentalType && !OFFERED[rentalType](listing))
    return {
      reason: "rental_type_not_offered",
      message: `This listing does not offer ${rentalType} rentals`,
    };
  if (!(endAt > startAt))
    return { reason: "invalid_interval", message: "endAt must be after startAt" };
  if (endAt.getTime() - startAt.getTime() < listing.minDurationMinutes * MIN)
    return {
      reason: "below_min_duration",
      message: `Minimum duration is ${listing.minDurationMinutes} minutes`,
    };
  if (listing.exceptions.some((x) => x.unavailable && x.startAt < endAt && x.endAt > startAt))
    return { reason: "exception_window", message: "The host has blocked part of this time" };
  if (!covered(listing, startAt, endAt))
    return { reason: "outside_schedule", message: "This time is outside the listing's hours" };
  return null;
}

export function isWithinSchedule(
  listing: ScheduledListing,
  startAt: Date,
  endAt: Date,
  rentalType?: RentalType,
): boolean {
  return scheduleProblem(listing, startAt, endAt, rentalType) === null;
}

/** One calendar month in IST: start date to the same date next month (Jan 31 → Feb 28/29). */
export function monthlyTermEnd(startAt: Date): Date {
  return new Date(addMonths(new TZDate(startAt, APP_TIMEZONE), 1).getTime());
}

/**
 * Inventory rows overlapping [startAt, blockedUntil) half-open. Holds past their
 * holdExpiresAt (DB time) don't count, even before the sweeper flips them.
 */
export function findConflicts(listingId: string, startAt: Date, blockedUntil: Date, tx: Tx = db) {
  return tx.$queryRaw<{ id: string; startAt: Date; blockedUntil: Date }[]>`
    SELECT id, "startAt", "blockedUntil" FROM "Booking"
    WHERE "listingId" = ${listingId}::uuid
      AND status IN (${BLOCKING_SQL})
      AND NOT (status = 'PENDING_PAYMENT' AND "holdExpiresAt" < now())
      AND "blockedRange" && tstzrange(${startAt}::timestamptz, ${blockedUntil}::timestamptz, '[)')
    ORDER BY "startAt"`;
}

/**
 * Flips stale holds (holdExpiresAt < now(), DB time) to EXPIRED and audits each one.
 * With `range`, only holds on that listing overlapping it. Returns the number expired.
 */
export function expireStaleHolds(
  tx: Tx = db,
  range?: { listingId: string; startAt: Date; blockedUntil: Date },
) {
  const scope = range
    ? Prisma.sql`AND "listingId" = ${range.listingId}::uuid
        AND "blockedRange" && tstzrange(${range.startAt}::timestamptz, ${range.blockedUntil}::timestamptz, '[)')`
    : Prisma.empty;
  return tx.$executeRaw`
    WITH expired AS (
      UPDATE "Booking" SET status = 'EXPIRED', "updatedAt" = now()
      WHERE status = 'PENDING_PAYMENT' AND "holdExpiresAt" < now() ${scope}
      RETURNING id
    )
    INSERT INTO "AuditLog" (action, "targetType", "targetId", reason, metadata, "updatedAt")
    SELECT 'booking.transition', 'Booking', id::text, 'hold_expired',
           '{"from":"PENDING_PAYMENT","to":"EXPIRED"}'::jsonb, now()
    FROM expired`;
}

/** Schedules the sweeper for the minute bucket after `at`; one job per bucket. */
export function scheduleHoldSweep(at: Date) {
  const bucket = Math.floor(at.getTime() / MIN) + 1;
  return enqueue(
    EXPIRE_HOLDS_JOB,
    {},
    {
      runAt: new Date(bucket * MIN),
      idempotencyKey: `${EXPIRE_HOLDS_JOB}:${bucket}`,
    },
  );
}

export type HoldInput = {
  listingId: string;
  renterId: string;
  vehicleId: string | null;
  rentalType: RentalType;
  startAt: Date;
  endAt: Date;
  quoteId: string;
  idempotencyKey: string;
  /** Set by monthly renewals (T4.3). */
  monthlyAgreementId?: string;
};

const TX_OPTIONS = { maxWait: 15_000, timeout: 15_000 };

/**
 * Concurrent inserts racing on the exclusion constraint can deadlock (Postgres 40P01,
 * surfaced by Prisma as P2034) instead of raising 23P01. A retry sees the winner's
 * committed row and fails cleanly with 23P01 → 409.
 */
async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (e) {
      const code = errorCode(e);
      if (i >= attempts || (code !== "40P01" && code !== "P2034")) throw e;
    }
  }
}

/**
 * Creates a PENDING_PAYMENT hold (FR-04). Idempotent per (renterId, idempotencyKey):
 * a repeat returns the same booking. 409 `slot_unavailable` when the slot is taken,
 * 422 with a `reason` for schedule, vehicle, or quote problems.
 */
export async function createHold(input: HoldInput): Promise<Booking> {
  const { renterId, idempotencyKey, startAt, endAt } = input;
  const byKey = () =>
    db.booking.findUnique({ where: { renterId_idempotencyKey: { renterId, idempotencyKey } } });
  const prior = await byKey();
  if (prior) return prior;

  // Reads that don't need the transaction stay outside it to keep lock time short.
  const quote = await validateQuote(input.quoteId, renterId, input.listingId, input.rentalType, {
    startAt,
    endAt,
  });
  if ((quote.vehicleId ?? null) !== input.vehicleId)
    throw unprocessable("quote_mismatch", "Quote does not match this booking");
  if (!input.vehicleId)
    throw unprocessable("vehicle_required", "Choose a vehicle for this booking");
  if (input.rentalType === "MONTHLY" && monthlyTermEnd(startAt).getTime() !== endAt.getTime())
    throw unprocessable(
      "invalid_monthly_term",
      "A monthly term runs from the start date to the same date next month",
    );
  const policy = await getActivePolicy();

  let booking: Booking;
  try {
    booking = await withDeadlockRetry(() =>
      db.$transaction(async (tx) => {
        const listing = await tx.listing.findUnique({
          where: { id: input.listingId },
          include: { availabilityRules: true, exceptions: true },
        });
        if (!listing)
          throw unprocessable("listing_unavailable", "This listing isn't taking bookings");
        const problem = scheduleProblem(listing, startAt, endAt, input.rentalType);
        if (problem) throw unprocessable(problem.reason, problem.message);

        const vehicle = await tx.vehicle.findUnique({ where: { id: input.vehicleId! } });
        if (!vehicle || vehicle.userId !== renterId || vehicle.deletedAt)
          throw unprocessable("vehicle_not_found", "Vehicle not found");
        const tooBig = (size: number | null, max: number | null) =>
          size != null && max != null && size > max;
        if (
          !listing.vehicleTypes.includes(vehicle.type) ||
          tooBig(vehicle.heightCm, listing.maxHeightCm) ||
          tooBig(vehicle.widthCm, listing.maxWidthCm) ||
          tooBig(vehicle.lengthCm, listing.maxLengthCm)
        )
          throw unprocessable("vehicle_incompatible", "This vehicle doesn't fit this space");

        const blockedUntil = new Date(endAt.getTime() + listing.turnoverBufferMinutes * MIN);
        await expireStaleHolds(tx, { listingId: listing.id, startAt, blockedUntil });
        const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
        return tx.booking.create({
          data: {
            listingId: listing.id,
            renterId,
            vehicleId: vehicle.id,
            rentalType: input.rentalType,
            startAt,
            endAt,
            blockedUntil,
            status: "PENDING_PAYMENT",
            holdExpiresAt: new Date(now.getTime() + policy.holdTtlMinutes * MIN),
            quoteId: quote.id,
            monthlyAgreementId: input.monthlyAgreementId,
            subtotalPaise: quote.subtotalPaise,
            renterFeePaise: quote.renterFeePaise,
            commissionPaise: quote.commissionPaise,
            hostEarningsPaise: quote.hostEarningsPaise,
            totalPaise: quote.totalPaise,
            currency: quote.currency,
            idempotencyKey,
          },
        });
      }, TX_OPTIONS),
    );
  } catch (e) {
    switch (errorCode(e)) {
      case "23P01":
        throw new HttpError("conflict", "This space is no longer available for that time", {
          reason: "slot_unavailable",
        });
      // Lock-order deadlock between concurrent stale-hold expiries: safe to retry.
      case "40P01":
        throw new HttpError("conflict", "Please try again", { reason: "try_again" });
      case "P2002":
      case "23505": {
        const raced = await byKey();
        if (raced) return raced;
        throw new HttpError("conflict", "This quote has already been used", {
          reason: "quote_already_used",
        });
      }
    }
    throw e;
  }
  // Durable expiry even if the renter closes the browser (FR-04 AC2).
  await scheduleHoldSweep(booking.holdExpiresAt!);
  return booking;
}

const MAX_AVAILABILITY_RANGE = 62 * DAY;

/**
 * GET /api/listings/:id/availability: rules, exceptions, and busy windows in [from, to).
 * Busy windows include the turnover buffer and say nothing about who booked.
 * Only PUBLISHED listings are public; the host and admins see any status.
 */
export async function getListingAvailability(
  listingId: string,
  viewer: { id: string; roles: string[] } | null,
  q: { from?: string; to?: string },
): Promise<GetAvailabilityResponse> {
  const from = q.from ? new Date(q.from) : new Date();
  const to = q.to ? new Date(q.to) : new Date(from.getTime() + 14 * DAY);
  if (!(to > from) || to.getTime() - from.getTime() > MAX_AVAILABILITY_RANGE)
    throw new HttpError("validation_error", "to must be after from and at most 62 days later");
  const listing = await db.listing.findUnique({
    where: { id: listingId },
    include: {
      availabilityRules: { orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] },
      exceptions: {
        where: { startAt: { lt: to }, endAt: { gt: from } },
        orderBy: { startAt: "asc" },
      },
    },
  });
  if (
    !listing ||
    !(
      listing.status === "PUBLISHED" ||
      viewer?.id === listing.hostId ||
      viewer?.roles.includes("ADMIN")
    )
  )
    throw new HttpError("not_found", "Listing not found");
  const busy = await findConflicts(listingId, from, to);
  return GetAvailabilityResponse.parse({
    listingId,
    timezone: APP_TIMEZONE,
    rules: listing.availabilityRules.map(({ weekday, startMinute, endMinute }) => ({
      weekday,
      startMinute,
      endMinute,
    })),
    exceptions: listing.exceptions.map((x) => ({
      startAt: x.startAt.toISOString(),
      endAt: x.endAt.toISOString(),
      unavailable: x.unavailable,
      reason: x.reason,
    })),
    busy: busy.map((b) => ({
      startAt: b.startAt.toISOString(),
      endAt: b.blockedUntil.toISOString(),
    })),
  });
}
