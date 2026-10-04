import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { BookingStatus, RentalType } from "@/generated/prisma/client";
import { testDb, truncateAll } from "../setup/db";

// FR-04 / plan §2.1: booking_no_overlap + booking_valid_interval, exercised directly.

const t = (hhmm: string) => new Date(`2030-01-07T${hhmm}:00Z`);
const MIN = 60_000;

let listingId: string;
let renterId: string;

function insert(opts: {
  start: Date;
  end: Date;
  bufferMin?: number;
  status?: BookingStatus;
  rentalType?: RentalType;
}) {
  return testDb.booking.create({
    data: {
      listingId,
      renterId,
      rentalType: opts.rentalType ?? "HOURLY",
      startAt: opts.start,
      endAt: opts.end,
      blockedUntil: new Date(opts.end.getTime() + (opts.bufferMin ?? 0) * MIN),
      status: opts.status ?? "CONFIRMED",
      subtotalPaise: 5000,
      commissionPaise: 500,
      hostEarningsPaise: 4500,
      totalPaise: 5000,
    },
  });
}

/** Postgres SQLSTATE from a Prisma driver-adapter error. */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const meta = (e as { meta?: { driverAdapterError?: { cause?: { code?: string } } } }).meta;
    return meta?.driverAdapterError?.cause?.code;
  }
  return undefined;
}

beforeEach(async () => {
  await truncateAll();
  const user = await testDb.user.create({ data: { email: "renter@test.local" } });
  const listing = await testDb.listing.create({
    data: {
      hostId: user.id,
      title: "Test bay",
      description: "d",
      address: "a",
      locality: "Baner",
      lat: 18.559,
      lng: 73.7868,
      approxLat: 18.56,
      approxLng: 73.79,
      spaceType: "OPEN",
    },
  });
  listingId = listing.id;
  renterId = user.id;
});

afterAll(() => testDb.$disconnect());

describe("booking_no_overlap", () => {
  test("(a) overlapping CONFIRMED bookings on one listing: second fails with 23P01", async () => {
    await insert({ start: t("10:00"), end: t("11:00") });
    expect(await pgCode(insert({ start: t("10:30"), end: t("11:30") }))).toBe("23P01");
  });

  test("(b) adjacent [10,11) and [11,12) both succeed with zero buffer", async () => {
    await insert({ start: t("10:00"), end: t("11:00") });
    await expect(insert({ start: t("11:00"), end: t("12:00") })).resolves.toBeDefined();
  });

  test("(c) 15-minute buffer: a booking starting at endAt conflicts", async () => {
    await insert({ start: t("10:00"), end: t("11:00"), bufferMin: 15 });
    expect(await pgCode(insert({ start: t("11:00"), end: t("12:00") }))).toBe("23P01");
    await expect(insert({ start: t("11:15"), end: t("12:00") })).resolves.toBeDefined();
  });

  test("(d) EXPIRED and CANCELLED rows do not block", async () => {
    await insert({ start: t("10:00"), end: t("11:00"), status: "EXPIRED" });
    await insert({ start: t("10:00"), end: t("11:00"), status: "CANCELLED" });
    await expect(insert({ start: t("10:00"), end: t("11:00") })).resolves.toBeDefined();
  });

  test("(e) a PENDING_PAYMENT hold blocks a CONFIRMED insert", async () => {
    await insert({ start: t("10:00"), end: t("11:00"), status: "PENDING_PAYMENT" });
    expect(await pgCode(insert({ start: t("10:00"), end: t("11:00") }))).toBe("23P01");
  });

  test("(f) a MONTHLY booking blocks an overlapping HOURLY one", async () => {
    await insert({
      start: new Date("2030-01-01T00:00:00Z"),
      end: new Date("2030-01-31T00:00:00Z"),
      rentalType: "MONTHLY",
    });
    expect(await pgCode(insert({ start: t("10:00"), end: t("11:00") }))).toBe("23P01");
  });

  test("(g) CHECK rejects endAt <= startAt", async () => {
    expect(await pgCode(insert({ start: t("10:00"), end: t("10:00") }))).toBe("23514");
    // endAt < startAt fails either in the CHECK or in building the generated range.
    expect(["23514", "22000"]).toContain(
      await pgCode(insert({ start: t("11:00"), end: t("10:00") })),
    );
  });

  test("bookings on different listings never conflict", async () => {
    await insert({ start: t("10:00"), end: t("11:00") });
    const other = await testDb.listing.create({
      data: {
        hostId: renterId,
        title: "Other",
        description: "d",
        address: "a",
        locality: "Baner",
        lat: 1,
        lng: 1,
        approxLat: 1,
        approxLng: 1,
        spaceType: "OPEN",
      },
    });
    listingId = other.id;
    await expect(insert({ start: t("10:00"), end: t("11:00") })).resolves.toBeDefined();
  });
});
