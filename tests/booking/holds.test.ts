import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RentalType } from "@/generated/prisma/client";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { createHold, findConflicts, isWithinSchedule, monthlyTermEnd } =
  await import("@/server/availability/service");
const { runOnce } = await import("@/server/jobs");
const { HOUR, MIN, ist, outcome, seedListing, seedQuote, seedUser, seedVehicle } =
  await import("./fixtures");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

type Listing = Awaited<ReturnType<typeof seedListing>>;
let key = 0;

/** Quotes and holds [startAt, endAt) for a fresh renter with a sedan. */
async function hold(
  listing: Listing,
  startAt: Date,
  endAt: Date,
  opts: { rentalType?: RentalType; vehicle?: Parameters<typeof seedVehicle>[1] } = {},
) {
  const renter = await seedUser();
  const vehicle = await seedVehicle(renter.id, opts.vehicle);
  const rentalType = opts.rentalType ?? "HOURLY";
  const quote = await seedQuote({
    listingId: listing.id,
    renterId: renter.id,
    vehicleId: vehicle.id,
    startAt,
    endAt,
    rentalType,
  });
  return createHold({
    listingId: listing.id,
    renterId: renter.id,
    vehicleId: vehicle.id,
    rentalType,
    startAt,
    endAt,
    quoteId: quote.id,
    idempotencyKey: `k${++key}`,
  });
}

const monthly = (listing: Listing) =>
  hold(listing, ist("00:00"), monthlyTermEnd(ist("00:00")), { rentalType: "MONTHLY" });

const expire = (id: string) =>
  testDb.booking.update({ where: { id }, data: { holdExpiresAt: new Date(Date.now() - MIN) } });

describe("createHold", () => {
  test("stores a PENDING_PAYMENT hold with DB-time expiry, the quote's totals, and a sweep job", async () => {
    const listing = await seedListing({ turnoverBufferMinutes: 15 });
    const before = Date.now();
    const b = await hold(listing, ist("10:00"), ist("11:00"));
    expect(b).toMatchObject({
      status: "PENDING_PAYMENT",
      totalPaise: 100_000,
      commissionPaise: 10_000,
    });
    expect(b.blockedUntil).toEqual(ist("11:15"));
    const ttl = b.holdExpiresAt!.getTime() - before;
    expect(ttl).toBeGreaterThan(9 * MIN);
    expect(ttl).toBeLessThan(11 * MIN);
    const job = await testDb.job.findFirstOrThrow({ where: { type: "bookings.expireHolds" } });
    expect(job.runAt.getTime()).toBeGreaterThan(b.holdExpiresAt!.getTime());
  });

  test("same (renter, idempotencyKey) returns the same booking", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);
    const quote = await seedQuote({
      listingId: listing.id,
      renterId: renter.id,
      vehicleId: vehicle.id,
      startAt: ist("10:00"),
      endAt: ist("11:00"),
    });
    const input = {
      listingId: listing.id,
      renterId: renter.id,
      vehicleId: vehicle.id,
      rentalType: "HOURLY" as const,
      startAt: ist("10:00"),
      endAt: ist("11:00"),
      quoteId: quote.id,
      idempotencyKey: "same",
    };
    const [a, b] = await Promise.all([createHold(input), createHold(input)]);
    expect(a.id).toBe(b.id);
    expect(await testDb.booking.count()).toBe(1);
  });

  test("an expired hold doesn't block a new one and is flipped to EXPIRED in the same transaction", async () => {
    const listing = await seedListing();
    const stale = await hold(listing, ist("10:00"), ist("11:00"));
    expect((await outcome(hold(listing, ist("10:00"), ist("11:00")))).status).toBe(409);

    await expire(stale.id);
    expect(await findConflicts(listing.id, ist("10:00"), ist("11:00"))).toEqual([]);
    const fresh = await hold(listing, ist("10:00"), ist("11:00"));
    expect(fresh.status).toBe("PENDING_PAYMENT");
    const after = await testDb.booking.findUniqueOrThrow({ where: { id: stale.id } });
    expect(after.status).toBe("EXPIRED");
    expect(
      await testDb.auditLog.count({ where: { targetId: stale.id, reason: "hold_expired" } }),
    ).toBe(1);
  });

  test("turnover buffer: the next booking may start only after endAt + buffer", async () => {
    const listing = await seedListing({ turnoverBufferMinutes: 15 });
    await hold(listing, ist("10:00"), ist("11:00"));
    expect(await outcome(hold(listing, ist("11:00"), ist("12:00")))).toEqual({
      status: 409,
      reason: "slot_unavailable",
    });
    // The new booking's own buffer counts too: [09:00, 10:00) blocks until 10:15.
    expect((await outcome(hold(listing, ist("09:00"), ist("10:00")))).status).toBe(409);
    await expect(hold(listing, ist("11:15"), ist("12:15"))).resolves.toBeDefined();
    await expect(hold(listing, ist("08:45"), ist("09:45"))).resolves.toBeDefined();
  });

  test("zero buffer: half-open intervals may touch", async () => {
    const listing = await seedListing();
    await hold(listing, ist("10:00"), ist("11:00"));
    await expect(hold(listing, ist("11:00"), ist("12:00"))).resolves.toBeDefined();
  });

  test("a MONTHLY term blocks an HOURLY hold inside it (FR-09 AC1)", async () => {
    const listing = await seedListing();
    const m = await monthly(listing);
    await testDb.booking.update({ where: { id: m.id }, data: { status: "CONFIRMED" } });
    expect(await outcome(hold(listing, ist("10:00", 20), ist("12:00", 20)))).toEqual({
      status: 409,
      reason: "slot_unavailable",
    });
  });

  test("an HOURLY booking blocks a MONTHLY term over it", async () => {
    const listing = await seedListing();
    await hold(listing, ist("10:00", 20), ist("12:00", 20));
    expect((await outcome(monthly(listing))).status).toBe(409);
  });

  test("MONTHLY must be exactly one calendar month in IST", async () => {
    // 31 Jan IST + 1 month = 28 Feb IST.
    expect(monthlyTermEnd(new Date("2030-01-30T18:30:00Z"))).toEqual(
      new Date("2030-02-27T18:30:00Z"),
    );
    const listing = await seedListing();
    expect(
      await outcome(hold(listing, ist("00:00"), ist("00:00", 31), { rentalType: "MONTHLY" })),
    ).toEqual({ status: 422, reason: "invalid_monthly_term" });
  });
});

describe("422s with clear reasons", () => {
  // Mon–Fri 09:00–18:00 IST only.
  const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: 540,
    endMinute: 1080,
  }));

  test("outside operating hours, and multi-day spans over a closed night", async () => {
    const listing = await seedListing({}, WEEKDAYS);
    const r = { status: 422, reason: "outside_schedule" };
    expect(await outcome(hold(listing, ist("17:00"), ist("19:00")))).toEqual(r);
    expect(await outcome(hold(listing, ist("10:00", 6), ist("12:00", 6)))).toEqual(r); // Sunday
    expect(await outcome(hold(listing, ist("10:00"), ist("10:00", 8)))).toEqual(r);
    await expect(hold(listing, ist("09:00"), ist("18:00"))).resolves.toBeDefined();
  });

  test("rules are IST wall-clock: Mon 09:00 IST is 03:30Z", async () => {
    const listing = await testDb.listing.findUniqueOrThrow({
      where: { id: (await seedListing({}, WEEKDAYS)).id },
      include: { availabilityRules: true, exceptions: true },
    });
    const at = (iso: string) => new Date(`2030-01-07T${iso}:00Z`);
    expect(isWithinSchedule(listing, at("03:30"), at("04:30"))).toBe(true);
    expect(isWithinSchedule(listing, at("03:00"), at("04:00"))).toBe(false);
  });

  test("a 24x7 listing allows a multi-day span", async () => {
    const listing = await seedListing();
    await expect(hold(listing, ist("10:00"), ist("10:00", 9))).resolves.toBeDefined();
  });

  test("blackout exception", async () => {
    const listing = await seedListing();
    await testDb.availabilityException.create({
      data: { listingId: listing.id, startAt: ist("11:00"), endAt: ist("13:00") },
    });
    expect(await outcome(hold(listing, ist("10:00"), ist("12:00")))).toEqual({
      status: 422,
      reason: "exception_window",
    });
    await expect(hold(listing, ist("13:00"), ist("14:00"))).resolves.toBeDefined();
  });

  test("an open exception adds hours outside the weekly rules", async () => {
    const listing = await seedListing({}, WEEKDAYS);
    await testDb.availabilityException.create({
      data: {
        listingId: listing.id,
        startAt: ist("18:00"),
        endAt: ist("21:00"),
        unavailable: false,
      },
    });
    await expect(hold(listing, ist("17:00"), ist("20:00"))).resolves.toBeDefined();
  });

  test("unpublished, suspended, and no-rules listings", async () => {
    for (const status of ["DRAFT", "SUSPENDED"] as const) {
      const listing = await seedListing({ status });
      expect(await outcome(hold(listing, ist("10:00"), ist("11:00")))).toEqual({
        status: 422,
        reason: "listing_unavailable",
      });
    }
    const closed = await seedListing({}, []);
    expect((await outcome(hold(closed, ist("10:00"), ist("11:00")))).reason).toBe(
      "outside_schedule",
    );
  });

  test("rental type not offered, and below the minimum duration", async () => {
    const listing = await seedListing({ monthlyPaise: null, minDurationMinutes: 120 });
    expect((await outcome(monthly(listing))).reason).toBe("rental_type_not_offered");
    expect((await outcome(hold(listing, ist("10:00"), ist("11:00")))).reason).toBe(
      "below_min_duration",
    );
  });

  test("incompatible vehicle type or dimensions", async () => {
    const listing = await seedListing({ maxHeightCm: 200 });
    const r = { status: 422, reason: "vehicle_incompatible" };
    const at = [ist("10:00"), ist("11:00")] as const;
    expect(await outcome(hold(listing, ...at, { vehicle: { type: "SUV" } }))).toEqual(r);
    expect(await outcome(hold(listing, ...at, { vehicle: { heightCm: 210 } }))).toEqual(r);
    await expect(hold(listing, ...at, { vehicle: { heightCm: 190 } })).resolves.toBeDefined();
  });

  test("expired quote, or a quote that doesn't match the request or the renter", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);
    const base = { listingId: listing.id, renterId: renter.id, vehicleId: vehicle.id };
    const interval = { startAt: ist("10:00"), endAt: ist("11:00") };
    const expired = await seedQuote({
      ...base,
      ...interval,
      expiresAt: new Date(Date.now() - MIN),
    });
    const input = {
      ...base,
      ...interval,
      rentalType: "HOURLY" as const,
      quoteId: expired.id,
      idempotencyKey: "q1",
    };
    expect((await outcome(createHold(input))).status).toBe(422);
    const ok = await seedQuote({ ...base, ...interval });
    const longer = new Date(interval.endAt.getTime() + HOUR);
    expect((await outcome(createHold({ ...input, quoteId: ok.id, endAt: longer }))).status).toBe(
      422,
    );
    const stranger = await seedUser();
    expect(
      (await outcome(createHold({ ...input, quoteId: ok.id, renterId: stranger.id }))).status,
    ).toBe(422);
    expect(await testDb.booking.count()).toBe(0);
  });
});

describe("bookings.expireHolds sweeper", () => {
  test("flips stale holds to EXPIRED with no booking attempt, and re-enqueues itself", async () => {
    const listing = await seedListing();
    const stale = await hold(listing, ist("10:00"), ist("11:00"));
    const live = await hold(listing, ist("12:00"), ist("13:00"));
    await expire(stale.id);
    // Make the scheduled sweep due now, as if its minute had arrived.
    const sweeps = { type: "bookings.expireHolds", status: "PENDING" as const };
    await testDb.job.updateMany({ where: sweeps, data: { runAt: new Date(0) } });

    const result = await runOnce("test-worker");
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
    expect(result.dead).toBe(0);
    const status = async (id: string) =>
      (await testDb.booking.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(stale.id)).toBe("EXPIRED");
    expect(await status(live.id)).toBe("PENDING_PAYMENT");
    expect(await testDb.job.count({ where: { ...sweeps, runAt: { gt: new Date() } } })).toBe(1);

    // Idempotent: a second sweep changes nothing.
    await testDb.job.updateMany({ where: sweeps, data: { runAt: new Date(0) } });
    await runOnce("test-worker");
    expect(await testDb.auditLog.count({ where: { reason: "hold_expired" } })).toBe(1);
  });
});
