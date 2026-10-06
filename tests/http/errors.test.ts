import { testDb, truncateAll } from "../setup/db";
import { afterAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { HttpError, toHttpError } from "@/server/http/errors";

afterAll(() => testDb.$disconnect());

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("toHttpError", () => {
  test("real PG 23P01 exclusion_violation from an overlapping booking → 409 conflict", async () => {
    await truncateAll();
    const host = await testDb.user.create({ data: { email: "h@test.local" } });
    const listing = await testDb.listing.create({
      data: {
        hostId: host.id,
        title: "t",
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
    const booking = () =>
      testDb.booking.create({
        data: {
          listingId: listing.id,
          renterId: host.id,
          rentalType: "HOURLY",
          startAt: new Date("2030-01-07T10:00:00Z"),
          endAt: new Date("2030-01-07T11:00:00Z"),
          blockedUntil: new Date("2030-01-07T11:00:00Z"),
          status: "CONFIRMED",
          subtotalPaise: 100,
          commissionPaise: 10,
          hostEarningsPaise: 90,
          totalPaise: 100,
        },
      });
    await booking();
    const err = toHttpError(await caught(booking()));
    expect(err).toMatchObject({ status: 409, code: "conflict", message: "conflict" });
  });

  test("real P2002 unique violation → 409, real P2025 → 404", async () => {
    await truncateAll();
    await testDb.user.create({ data: { email: "dup@test.local" } });
    const dup = toHttpError(
      await caught(testDb.user.create({ data: { email: "dup@test.local" } })),
    );
    expect(dup.status).toBe(409);
    const missing = toHttpError(
      await caught(
        testDb.user.update({
          where: { id: "00000000-0000-0000-0000-000000000000" },
          data: { name: "x" },
        }),
      ),
    );
    expect(missing.status).toBe(404);
  });

  test("zod → 400, HttpError passes through, unknown → opaque 500", () => {
    expect(toHttpError(z.string().safeParse(1).error).status).toBe(400);
    expect(toHttpError(new HttpError("forbidden", "no")).status).toBe(403);
    const err = toHttpError(new Error("db password is hunter2"));
    expect(err).toMatchObject({ status: 500, message: "Internal server error" });
  });
});
