import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { createHold } = await import("@/server/availability/service");
const { ist, outcome, seedListing, seedQuote, seedUser, seedVehicle } = await import("./fixtures");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

// FR-04 AC1. testDb is a pg pool of 10 connections, so the 20 transactions genuinely
// race; booking_no_overlap (23P01) decides the winner, never the app-level pre-check.
test("20 parallel holds on one slot: exactly 1 succeeds, 19 get 409 slot_unavailable, no 500", async () => {
  const listing = await seedListing();
  const startAt = ist("10:00");
  const endAt = ist("12:00");
  const renters = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const renter = await seedUser();
      const vehicle = await seedVehicle(renter.id);
      // quoteId is unique on Booking, so each attempt needs its own quote.
      const quote = await seedQuote({
        listingId: listing.id,
        renterId: renter.id,
        vehicleId: vehicle.id,
        startAt,
        endAt,
      });
      return { renter, vehicle, quote };
    }),
  );

  const results = await Promise.all(
    renters.map(({ renter, vehicle, quote }, i) =>
      outcome(
        createHold({
          listingId: listing.id,
          renterId: renter.id,
          vehicleId: vehicle.id,
          rentalType: "HOURLY",
          startAt,
          endAt,
          quoteId: quote.id,
          idempotencyKey: `race-${i}`,
        }),
      ),
    ),
  );

  const counts = {
    succeeded: results.filter((r) => r.status === 200).length,
    slotUnavailable409: results.filter((r) => r.status === 409 && r.reason === "slot_unavailable")
      .length,
    other: results.filter((r) => r.status !== 200 && r.reason !== "slot_unavailable"),
  };
  console.log(`[concurrency] ${JSON.stringify({ ...counts, other: counts.other.length })}`);
  expect(counts.other).toEqual([]);
  expect(counts.succeeded).toBe(1);
  expect(counts.slotUnavailable409).toBe(19);
  expect(await testDb.booking.count({ where: { listingId: listing.id } })).toBe(1);
}, 30_000); // 20 parallel transactions: slow under machine load, not a deadlock
