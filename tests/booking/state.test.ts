import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { BookingStatus, Prisma } from "@/generated/prisma/client";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { TRANSITIONS, confirmHeldBooking, transition } = await import("@/server/bookings/state");
const { MIN, ist, outcome, seedListing, seedUser } = await import("./fixtures");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

async function booking(status: BookingStatus, holdExpiresAt: Date | null = null) {
  const listing = await seedListing();
  const renter = await seedUser();
  return testDb.booking.create({
    data: {
      listingId: listing.id,
      renterId: renter.id,
      rentalType: "HOURLY",
      startAt: ist("10:00"),
      endAt: ist("11:00"),
      blockedUntil: ist("11:00"),
      status,
      holdExpiresAt,
      subtotalPaise: 100,
      commissionPaise: 10,
      hostEarningsPaise: 90,
      totalPaise: 100,
    },
  });
}

const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => testDb.$transaction(fn);

describe("transition", () => {
  test("legal move updates status and writes an audit entry", async () => {
    const b = await booking("CONFIRMED");
    const actor = await seedUser();
    const updated = await run((tx) => transition(tx, b.id, "ACTIVE", actor.id, "checked in"));
    expect(updated.status).toBe("ACTIVE");
    const log = await testDb.auditLog.findFirstOrThrow({ where: { targetId: b.id } });
    expect(log).toMatchObject({
      actorId: actor.id,
      action: "booking.transition",
      metadata: { from: "CONFIRMED", to: "ACTIVE" },
    });
  });

  test("every move outside the PRD §5 table throws 409 illegal_transition", async () => {
    const all = Object.keys(TRANSITIONS) as BookingStatus[];
    for (const from of all) {
      // Inventory-holding rows overlap, so each one gets its own listing.
      const b = await booking(from);
      for (const to of all.filter((s) => !TRANSITIONS[from].includes(s)))
        expect(await outcome(run((tx) => transition(tx, b.id, to, null)))).toEqual({
          status: 409,
          reason: "illegal_transition",
        });
    }
    expect(await testDb.auditLog.count()).toBe(0);
  });

  test("two concurrent transitions from the same state: exactly one wins", async () => {
    const b = await booking("CONFIRMED");
    // A third transaction holds the row lock, so both transitions read CONFIRMED and then
    // queue on their UPDATE; only the WHERE status = from guard can stop the second.
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = run(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${b.id}::uuid FOR UPDATE`;
      locked();
      await new Promise<void>((r) => (release = r));
    });
    await isLocked;
    const racing = Promise.all([
      outcome(run((tx) => transition(tx, b.id, "ACTIVE", null))),
      outcome(run((tx) => transition(tx, b.id, "CANCELLED", null, "renter cancelled"))),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const results = await racing;
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.reason).toBe("status_changed");
    expect(await testDb.auditLog.count({ where: { targetId: b.id } })).toBe(1);
  });
});

describe("confirmHeldBooking", () => {
  test("confirms an unexpired hold", async () => {
    const b = await booking("PENDING_PAYMENT", new Date(Date.now() + 5 * MIN));
    expect((await run((tx) => confirmHeldBooking(tx, b.id))).status).toBe("CONFIRMED");
  });

  test("rejects a hold expired by DB time, even before the sweeper runs", async () => {
    const b = await booking("PENDING_PAYMENT", new Date(Date.now() - MIN));
    expect(await outcome(run((tx) => confirmHeldBooking(tx, b.id)))).toEqual({
      status: 409,
      reason: "hold_expired",
    });
    const after = await testDb.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe("PENDING_PAYMENT");
  });
});
