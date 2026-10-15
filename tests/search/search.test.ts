import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { BookingStatus, RentalType } from "@/generated/prisma/client";
import { noParams, req } from "../http/helpers";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { GET } = await import("@/app/api/listings/route");
const { monthlyTermEnd } = await import("@/server/availability/service");
const { MIN, ist, seedListing, seedUser } = await import("../booking/fixtures");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

type Card = { id: string; distanceMeters: number | null; priceFrom: { paise: number } | null };

async function search(params: Record<string, string | number | boolean>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await GET(req(`/api/listings?${qs}`), noParams);
  const body = await res.json();
  return { status: res.status, body, items: (body.items ?? []) as Card[] };
}
const ids = async (params: Record<string, string | number | boolean>) =>
  (await search(params)).items.map((c) => c.id);

const near = { lat: 18.53, lng: 73.84, radiusMeters: 5000 };
const window = (from: string, to: string) => ({
  startAt: ist(from).toISOString(),
  endAt: ist(to).toISOString(),
});

async function book(
  listingId: string,
  startAt: Date,
  endAt: Date,
  status: BookingStatus = "CONFIRMED",
  extra: { rentalType?: RentalType; holdExpiresAt?: Date; blockedUntil?: Date } = {},
) {
  const renter = await seedUser();
  return testDb.booking.create({
    data: {
      listingId,
      renterId: renter.id,
      rentalType: extra.rentalType ?? "HOURLY",
      startAt,
      endAt,
      blockedUntil: extra.blockedUntil ?? endAt,
      status,
      holdExpiresAt: extra.holdExpiresAt,
      subtotalPaise: 100,
      commissionPaise: 10,
      hostEarningsPaise: 90,
      totalPaise: 100,
    },
  });
}

describe("time interval", () => {
  test("a booked listing is excluded for an overlapping window, included otherwise", async () => {
    const l = await seedListing();
    await book(l.id, ist("10:00"), ist("12:00"));
    expect(await ids({ ...near, ...window("11:00", "13:00") })).toEqual([]);
    expect(await ids({ ...near, ...window("12:00", "14:00") })).toEqual([l.id]);
    expect(await ids(near)).toEqual([l.id]);
  });

  test("the listing's turnover buffer extends the requested window, as in createHold", async () => {
    const l = await seedListing({ turnoverBufferMinutes: 30 });
    await book(l.id, ist("14:15"), ist("15:00"));
    expect(await ids({ ...near, ...window("13:00", "14:00") })).toEqual([]);
    expect(await ids({ ...near, ...window("12:00", "13:45") })).toEqual([l.id]);
  });

  test("a monthly term excludes short-term searches inside it (FR-04 AC5)", async () => {
    const l = await seedListing();
    const start = ist("00:00", 1);
    await book(l.id, start, monthlyTermEnd(start), "CONFIRMED", { rentalType: "MONTHLY" });
    expect(await ids({ ...near, ...window("09:00", "11:00") })).toEqual([]);
    // A monthly search gives only the start date.
    expect(
      await ids({ ...near, rentalType: "MONTHLY", startAt: ist("00:00", 15).toISOString() }),
    ).toEqual([]);
  });

  test("an expired hold doesn't exclude; a live one does", async () => {
    const l = await seedListing();
    await book(l.id, ist("10:00"), ist("12:00"), "PENDING_PAYMENT", {
      holdExpiresAt: new Date(Date.now() - MIN),
    });
    expect(await ids({ ...near, ...window("10:00", "11:00") })).toEqual([l.id]);
    await book(l.id, ist("13:00"), ist("14:00"), "PENDING_PAYMENT", {
      holdExpiresAt: new Date(Date.now() + 10 * MIN),
    });
    expect(await ids({ ...near, ...window("13:00", "14:00") })).toEqual([]);
  });

  test("outside the weekly schedule or in a blackout is excluded", async () => {
    // Monday 08:00–20:00 only; 7 Jan 2030 is a Monday.
    const l = await seedListing({}, [{ weekday: 1, startMinute: 480, endMinute: 1200 }]);
    expect(await ids({ ...near, ...window("09:00", "11:00") })).toEqual([l.id]);
    expect(await ids({ ...near, ...window("19:00", "21:00") })).toEqual([]);
    expect(
      await ids({
        ...near,
        startAt: ist("09:00", 8).toISOString(),
        endAt: ist("10:00", 8).toISOString(),
      }),
    ).toEqual([]);
    await testDb.availabilityException.create({
      data: { listingId: l.id, startAt: ist("09:30"), endAt: ist("10:30"), unavailable: true },
    });
    expect(await ids({ ...near, ...window("09:00", "11:00") })).toEqual([]);
  });

  test("priceFrom is the price of the searched rental type and interval", async () => {
    await seedListing({ hourlyPaise: 5_000, monthlyPaise: 400_000 });
    const [hourly] = (await search({ ...near, rentalType: "HOURLY", ...window("09:00", "12:00") }))
      .items;
    expect(hourly.priceFrom?.paise).toBe(15_000);
    const [unit] = (await search(near)).items;
    expect(unit.priceFrom?.paise).toBe(5_000);
  });

  test("a half-specified interval is a validation error", async () => {
    expect((await search({ ...near, startAt: ist("09:00").toISOString() })).status).toBe(400);
    expect((await search({ ...near, endAt: ist("09:00").toISOString() })).status).toBe(400);
  });
});

describe("filters", () => {
  test("SUSPENDED and DRAFT listings are never returned", async () => {
    const pub = await seedListing();
    await seedListing({ status: "SUSPENDED" });
    await seedListing({ status: "DRAFT" });
    expect(await ids(near)).toEqual([pub.id]);
    expect(await ids({ ...near, ...window("09:00", "10:00") })).toEqual([pub.id]);
  });

  test("vehicle height: limits below the vehicle exclude, unset limits pass", async () => {
    const low = await seedListing({ maxHeightCm: 180 });
    const high = await seedListing({ maxHeightCm: 220, lat: 18.531, approxLat: 18.534 });
    const open = await seedListing({ maxHeightCm: null, lat: 18.532, approxLat: 18.537 });
    expect((await ids({ ...near, minHeightCm: 200 })).sort()).toEqual([high.id, open.id].sort());
    expect(await ids({ ...near, minHeightCm: 150 })).toContain(low.id);
  });

  test("rental type, price range, vehicle type, covered, amenities", async () => {
    const a = await seedListing({ hourlyPaise: 3_000, covered: true, lit: true });
    const b = await seedListing({ hourlyPaise: null, dailyPaise: 20_000, vehicleTypes: ["SUV"] });
    expect(await ids({ ...near, rentalType: "HOURLY" })).toEqual([a.id]);
    expect(await ids({ ...near, rentalType: "MULTI_DAY" })).toEqual([b.id]);
    expect(await ids({ ...near, rentalType: "HOURLY", maxPricePaise: 2_000 })).toEqual([]);
    expect(await ids({ ...near, rentalType: "HOURLY", minPricePaise: 3_000 })).toEqual([a.id]);
    expect(await ids({ ...near, vehicleType: "SUV" })).toEqual([b.id]);
    expect(await ids({ ...near, covered: true })).toEqual([a.id]);
    expect(await ids({ ...near, amenities: "lit" })).toEqual([a.id]);
    expect(await ids({ ...near, amenities: "lit,evCharging" })).toEqual([]);
  });
});

describe("privacy", () => {
  test("result JSON has no exact coordinates, address, or access instructions", async () => {
    await seedListing();
    const { body } = await search(near);
    expect(body.items).toHaveLength(1);
    const keys = Object.keys(body.items[0]);
    for (const k of ["lat", "lng", "address", "accessInstructions", "hostId"])
      expect(keys).not.toContain(k);
    expect(JSON.stringify(body)).not.toContain("12 FC Road");
    expect(JSON.stringify(body)).not.toContain("Gate code");
  });
});

describe("area and ordering", () => {
  test("ordered by distance from the centre, with cursor pagination", async () => {
    const far = await seedListing({ lat: 18.56, lng: 73.84, approxLat: 18.561, approxLng: 73.84 });
    const mid = await seedListing({ lat: 18.545, lng: 73.84, approxLat: 18.546, approxLng: 73.84 });
    const close = await seedListing({
      lat: 18.531,
      lng: 73.84,
      approxLat: 18.531,
      approxLng: 73.84,
    });
    const first = await search({ ...near, limit: 2 });
    expect(first.items.map((c) => c.id)).toEqual([close.id, mid.id]);
    const d = first.items.map((c) => c.distanceMeters!);
    expect(d[0]).toBeLessThan(d[1]);
    expect(Math.abs(d[1] - 1779)).toBeLessThan(5); // 0.016° of latitude, from approxLat
    const second = await search({ ...near, limit: 2, cursor: first.body.nextCursor });
    expect(second.items.map((c) => c.id)).toEqual([far.id]);
    expect(second.body.nextCursor).toBeNull();
    // Radius cuts by distance, not just the bounding box.
    expect(await ids({ ...near, radiusMeters: 2000 })).toEqual([close.id, mid.id]);
  });

  test("sort by price", async () => {
    const pricey = await seedListing({ hourlyPaise: 9_000 });
    const cheap = await seedListing({ hourlyPaise: 1_000, approxLat: 18.55, lat: 18.55 });
    expect(await ids({ ...near, sort: "price" })).toEqual([cheap.id, pricey.id]);
    const first = await search({ ...near, sort: "price", limit: 1 });
    expect(first.items.map((c) => c.id)).toEqual([cheap.id]);
    const second = await search({
      ...near,
      sort: "price",
      limit: 1,
      cursor: first.body.nextCursor,
    });
    expect(second.items.map((c) => c.id)).toEqual([pricey.id]);
    expect(second.body.nextCursor).toBeNull();
  });

  test("space types", async () => {
    const stilt = await seedListing({ spaceType: "STILT" });
    await seedListing({ spaceType: "DRIVEWAY" });
    expect(await ids({ ...near, spaceTypes: "STILT,GARAGE" })).toEqual([stilt.id]);
  });

  test("a viewport outside Pune is empty; one straddling the edge is clamped", async () => {
    const l = await seedListing();
    const mumbai = { minLat: 19.0, minLng: 72.8, maxLat: 19.1, maxLng: 72.9 };
    expect(await search(mumbai)).toMatchObject({ status: 200, items: [] });
    const straddle = { minLat: 18.5, minLng: 73.5, maxLat: 19.5, maxLng: 73.9 };
    const res = await search(straddle);
    expect(res.items.map((c) => c.id)).toEqual([l.id]);
    expect(res.items[0].distanceMeters).toBeNull();
  });

  test("bad input: partial viewport, lat without lng, malformed cursor", async () => {
    expect((await search({ minLat: 18.5, maxLat: 18.6 })).status).toBe(400);
    expect((await search({ lat: 18.5 })).status).toBe(400);
    expect((await search({ ...near, cursor: "nope" })).status).toBe(400);
  });
});

describe("ratings (FR-11 summary)", () => {
  test("cards and the public detail share listingRatingSummary: approved only, one decimal", async () => {
    const { GET: detail } = await import("@/app/api/listings/[id]/route");
    const listing = await seedListing();
    const other = await seedListing();
    for (const [rating, moderationStatus] of [
      [5, "APPROVED"],
      [4, "APPROVED"],
      [4, "APPROVED"],
      [1, "PENDING"],
    ] as const) {
      const b = await book(listing.id, ist("08:00", 1), ist("09:00", 1), "COMPLETED");
      await testDb.review.create({
        data: {
          bookingId: b.id,
          listingId: listing.id,
          authorId: b.renterId,
          rating,
          moderationStatus,
        },
      });
    }
    const { items } = await search(near);
    const cards = items as unknown as { id: string; rating: unknown }[];
    expect(cards.find((c) => c.id === listing.id)?.rating).toEqual({ average: 4.3, count: 3 });
    expect(cards.find((c) => c.id === other.id)?.rating).toEqual({ average: null, count: 0 });
    const res = await detail(req(`/api/listings/${listing.id}`), {
      params: Promise.resolve({ id: listing.id }),
    });
    expect((await res.json()).rating).toEqual({ average: 4.3, count: 3 });
  });
});
