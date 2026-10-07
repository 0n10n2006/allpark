import { randomUUID } from "node:crypto";
import type { Prisma, RentalType } from "@/generated/prisma/client";
import { getActivePolicy } from "@/config/policy";
import { toHttpError } from "@/server/http/errors";
import { testDb } from "../setup/db";

// Callers must vi.mock("@/server/db") to testDb before importing this file.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** Monday 7 Jan 2030, given as IST wall-clock "HH:mm" → UTC instant. */
export const ist = (hhmm: string, day = 7) =>
  new Date(`2030-01-${String(day).padStart(2, "0")}T${hhmm}:00+05:30`);

const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 1440,
}));

export async function seedUser() {
  return testDb.user.create({ data: { email: `${randomUUID()}@test.local` } });
}

export async function seedVehicle(userId: string, data: Partial<Prisma.VehicleCreateInput> = {}) {
  return testDb.vehicle.create({
    data: {
      userId,
      registration: `MH12${randomUUID().slice(0, 6)}`,
      type: "SEDAN",
      ...data,
    } as Prisma.VehicleUncheckedCreateInput,
  });
}

/** PUBLISHED, open 24x7, hourly + monthly prices, sedans only. */
export async function seedListing(
  data: Partial<Prisma.ListingUncheckedCreateInput> = {},
  rules = ALL_DAY,
) {
  const host = await testDb.user.create({
    data: {
      email: `${randomUUID()}@test.local`,
      roles: ["HOST"],
      name: "Host",
      phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    },
  });
  return testDb.listing.create({
    data: {
      hostId: host.id,
      title: "Stilt bay",
      description: "Covered",
      address: "12 FC Road",
      locality: "Shivajinagar",
      lat: 18.53,
      lng: 73.84,
      approxLat: 18.531,
      approxLng: 73.84,
      spaceType: "STILT",
      vehicleTypes: ["SEDAN"],
      hourlyPaise: 50_000,
      monthlyPaise: 500_000,
      minDurationMinutes: 60,
      accessInstructions: "Gate code 4321",
      status: "PUBLISHED",
      ...data,
      availabilityRules: { create: rules },
    },
  });
}

/** A persisted quote, as POST /api/quotes would create it. */
export async function seedQuote(q: {
  listingId: string;
  renterId: string;
  vehicleId: string | null;
  startAt: Date;
  endAt: Date;
  rentalType?: RentalType;
  expiresAt?: Date;
}) {
  const policy = await getActivePolicy();
  return testDb.priceQuote.create({
    data: {
      listingId: q.listingId,
      renterId: q.renterId,
      vehicleId: q.vehicleId,
      rentalType: q.rentalType ?? "HOURLY",
      startAt: q.startAt,
      endAt: q.endAt,
      lineItems: [],
      subtotalPaise: 100_000,
      commissionPaise: 10_000,
      hostEarningsPaise: 90_000,
      totalPaise: 100_000,
      policyVersionId: policy.id,
      expiresAt: q.expiresAt ?? new Date(Date.now() + 15 * MIN),
    },
  });
}

/** Status code and `details.reason` of whatever a promise rejects with, as the API would map it. */
export async function outcome(p: Promise<unknown>) {
  try {
    await p;
    return { status: 200, reason: undefined };
  } catch (e) {
    const err = toHttpError(e);
    return { status: err.status, reason: (err.details as { reason?: string })?.reason };
  }
}
