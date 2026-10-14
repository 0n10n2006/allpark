import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { BookingStatus } from "@/generated/prisma/client";
import { testDb, truncateAll } from "../setup/db";
import { req, seedSession } from "../http/helpers";
import { FakeProvider } from "../payments/fake-provider";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST: checkInRoute } = await import("@/app/api/bookings/[id]/check-in/route");
const { POST: checkOutRoute } = await import("@/app/api/bookings/[id]/check-out/route");
const { POST: extendRoute } = await import("@/app/api/bookings/[id]/extend/route");
const { POST: incidentRoute } = await import("@/app/api/bookings/[id]/incidents/route");
const { setPaymentProvider } = await import("@/server/payments/provider");
const { settlePayment } = await import("@/server/payments/service");
const { bookingEarnings } = await import("@/server/payouts/earnings");
const sessions = await import("@/server/sessions/service");
const { MIN, seedListing, seedVehicle } = await import("../booking/fixtures");

let fake: FakeProvider;
beforeEach(async () => {
  await truncateAll();
  fake = new FakeProvider();
  setPaymentProvider(fake);
});
afterAll(async () => {
  setPaymentProvider(null);
  await testDb.$disconnect();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const at = (minutesFromNow: number) =>
  new Date(Math.floor(Date.now() / MIN) * MIN + minutesFromNow * MIN);

/** A booking on a 24x7 ₹500/h listing, created directly with the given times and status. */
async function seed(o: {
  start: number;
  end: number;
  status?: BookingStatus;
  checkedIn?: boolean;
}) {
  const host = await seedSession(["HOST"]);
  const listing = await seedListing({ hostId: host.user.id });
  const renter = await seedSession();
  const vehicle = await seedVehicle(renter.user.id);
  const booking = await testDb.booking.create({
    data: {
      listingId: listing.id,
      renterId: renter.user.id,
      vehicleId: vehicle.id,
      rentalType: "HOURLY",
      startAt: at(o.start),
      endAt: at(o.end),
      blockedUntil: at(o.end),
      status: o.status ?? "CONFIRMED",
      checkedInAt: o.checkedIn ? at(o.start) : null,
      subtotalPaise: 100_000,
      commissionPaise: 10_000,
      hostEarningsPaise: 90_000,
      totalPaise: 100_000,
    },
  });
  return { host, renter, listing, booking, id: booking.id };
}

const post = (
  handler: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>,
  path: string,
  id: string,
  cookie: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  handler(
    req(`/api/bookings/${id}/${path}`, { method: "POST", cookie, body, headers }),
    params(id),
  );
const checkIn = (id: string, cookie: string, body: unknown = {}) =>
  post(checkInRoute, "check-in", id, cookie, body);
const checkOut = (id: string, cookie: string) => post(checkOutRoute, "check-out", id, cookie);
const extend = (id: string, cookie: string, newEndAt: Date, key = randomUUID()) =>
  post(
    extendRoute,
    "extend",
    id,
    cookie,
    { newEndAt: newEndAt.toISOString() },
    {
      "idempotency-key": key,
    },
  );

const status = async (id: string) =>
  (await testDb.booking.findUniqueOrThrow({ where: { id } })).status;
const events = (bookingId: string) =>
  testDb.sessionEvent.findMany({ where: { bookingId }, orderBy: { occurredAt: "asc" } });
const graceJob = (b: { id: string; endAt: Date }) => ({
  bookingId: b.id,
  endAt: b.endAt.toISOString(),
});

describe("check-in", () => {
  test("outside the arrival window → 422", async () => {
    const s = await seed({ start: 60, end: 180 });
    const res = await checkIn(s.id, s.renter.cookie);
    expect(res.status).toBe(422);
    expect((await res.json()).error.details.reason).toBe("outside_arrival_window");
    expect(await status(s.id)).toBe("CONFIRMED");
  });

  test("15 minutes early is allowed; CHECK_IN recorded once; host confirms without a state change", async () => {
    const s = await seed({ start: 14, end: 120 });
    const res = await checkIn(s.id, s.renter.cookie, { note: "Bay 3" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ACTIVE");
    expect((await checkIn(s.id, s.renter.cookie)).status).toBe(200); // repeat tap

    const host = await checkIn(s.id, s.host.cookie, { asHost: true });
    expect(host.status).toBe(200);
    expect((await host.json()).status).toBe("ACTIVE");

    const ev = await events(s.id);
    expect(ev.map((e) => e.type)).toEqual(["CHECK_IN", "HOST_CONFIRMED_ARRIVAL"]);
    expect(ev[0]).toMatchObject({ actorId: s.renter.user.id, metadata: { note: "Bay 3" } });
    expect(ev[1].actorId).toBe(s.host.user.id);
    const b = await testDb.booking.findUniqueOrThrow({ where: { id: s.id } });
    expect(b.checkedInAt).not.toBeNull();
  });

  test("a renter can't confirm as host; the host can't start the renter's parking", async () => {
    const s = await seed({ start: -5, end: 120 });
    expect((await checkIn(s.id, s.renter.cookie, { asHost: true })).status).toBe(403);
    expect((await checkIn(s.id, s.host.cookie)).status).toBe(403);
  });
});

describe("check-out", () => {
  test("ACTIVE → COMPLETED with CHECK_OUT, and pending reminders are cancelled", async () => {
    const s = await seed({ start: -30, end: 90, status: "ACTIVE", checkedIn: true });
    await sessions.scheduleSessionJobs(s.id);
    expect(
      await testDb.notification.count({
        where: { idempotencyKey: { startsWith: `session:${s.id}:` }, status: "PENDING" },
      }),
    ).toBe(2);

    const res = await checkOut(s.id, s.renter.cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("COMPLETED");
    expect((await checkOut(s.id, s.renter.cookie)).status).toBe(200); // repeat
    const ev = await events(s.id);
    expect(ev.map((e) => e.type)).toEqual(["CHECK_OUT"]);
    expect(ev[0]).toMatchObject({ actorId: s.renter.user.id, metadata: { by: "renter" } });
    expect(
      await testDb.notification.count({
        where: { idempotencyKey: { startsWith: `session:${s.id}:` }, status: "PENDING" },
      }),
    ).toBe(0);
  });

  test("the host can confirm departure", async () => {
    const s = await seed({ start: -60, end: -5, status: "GRACE_PERIOD", checkedIn: true });
    const res = await checkOut(s.id, s.host.cookie);
    expect(res.status).toBe(200);
    expect((await events(s.id))[0].metadata).toMatchObject({ by: "host" });
  });

  test("a CONFIRMED booking that never started can't be checked out", async () => {
    const s = await seed({ start: -5, end: 60 });
    expect((await checkOut(s.id, s.renter.cookie)).status).toBe(409);
  });
});

describe("reminders and grace jobs", () => {
  test("scheduleSessionJobs enqueues arrival, 30/10-minute reminders, and grace jobs at the right times", async () => {
    const s = await seed({ start: 60, end: 180 });
    await sessions.scheduleSessionJobs(s.id);
    await sessions.scheduleSessionJobs(s.id); // idempotent
    const end = s.booking.endAt.toISOString();
    const notes = await testDb.notification.findMany({ orderBy: { scheduledAt: "asc" } });
    expect(notes.map((n) => [n.type, n.idempotencyKey, n.scheduledAt.getTime()])).toEqual([
      [
        "ARRIVAL_UPCOMING",
        `session:${s.id}:arrival:${s.booking.startAt.toISOString()}`,
        at(30).getTime(),
      ],
      ["SESSION_ENDING", `session:${s.id}:ending:${end}:30`, at(150).getTime()],
      ["SESSION_ENDING", `session:${s.id}:ending:${end}:10`, at(170).getTime()],
    ]);
    expect(notes.every((n) => n.userId === s.renter.user.id)).toBe(true);
    const jobs = await testDb.job.findMany({
      where: { type: { startsWith: "sessions." } },
      orderBy: { runAt: "asc" },
    });
    expect(jobs.map((j) => [j.type, j.runAt.getTime(), j.payload])).toEqual([
      ["sessions.startGrace", at(180).getTime(), { bookingId: s.id, endAt: end }],
      ["sessions.graceExpired", at(190).getTime(), { bookingId: s.id, endAt: end }],
    ]);
  });

  test("MONTHLY terms get no session reminders or grace jobs (a term end isn't an overstay)", async () => {
    const s = await seed({ start: 60, end: 180 });
    await testDb.booking.update({ where: { id: s.id }, data: { rentalType: "MONTHLY" } });
    await sessions.scheduleSessionJobs(s.id);
    expect(await testDb.notification.count()).toBe(0);
    expect(await testDb.job.count({ where: { type: { startsWith: "sessions." } } })).toBe(0);
  });

  test("reminders already in the past are skipped", async () => {
    const s = await seed({ start: -60, end: 20, status: "ACTIVE", checkedIn: true });
    await sessions.scheduleSessionJobs(s.id);
    const notes = await testDb.notification.findMany();
    expect(notes.map((n) => n.idempotencyKey)).toEqual([
      `session:${s.id}:ending:${s.booking.endAt.toISOString()}:10`,
    ]);
  });

  test("startGrace: ACTIVE → GRACE_PERIOD", async () => {
    const s = await seed({ start: -120, end: -1, status: "ACTIVE", checkedIn: true });
    await sessions.startGrace(graceJob(s.booking));
    expect(await status(s.id)).toBe("GRACE_PERIOD");
    expect((await events(s.id)).map((e) => e.type)).toEqual(["GRACE_STARTED"]);
  });

  test("no-show: never checked in → GRACE_PERIOD recorded as NO_SHOW_OR_UNCONFIRMED, no penalty", async () => {
    const s = await seed({ start: -120, end: -1 });
    await sessions.startGrace(graceJob(s.booking));
    expect(await status(s.id)).toBe("GRACE_PERIOD");
    expect((await events(s.id)).map((e) => e.type)).toEqual(["NO_SHOW_OR_UNCONFIRMED"]);
    await sessions.graceExpired(graceJob(s.booking));
    expect(await status(s.id)).toBe("OVERSTAY");
    // Notified, but nothing charged or moved.
    expect(await testDb.notification.count({ where: { type: "GRACE_EXPIRED_RENTER" } })).toBe(1);
    expect(await testDb.payment.count()).toBe(0);
    expect(await testDb.ledgerEntry.count()).toBe(0);
    const b = await testDb.booking.findUniqueOrThrow({ where: { id: s.id } });
    expect(b.totalPaise).toBe(100_000);
  });

  test("graceExpired: GRACE_PERIOD → OVERSTAY, a system incident, and notifications to both", async () => {
    const s = await seed({ start: -120, end: -11, status: "GRACE_PERIOD", checkedIn: true });
    await sessions.graceExpired(graceJob(s.booking));
    await sessions.graceExpired(graceJob(s.booking)); // a retried job doesn't duplicate anything
    expect(await status(s.id)).toBe("OVERSTAY");
    const incidents = await testDb.overstayIncident.findMany({ where: { bookingId: s.id } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ status: "OPEN", reportedById: null });
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: "incident.opened" } });
    expect(audit).toMatchObject({ actorId: null, targetId: incidents[0].id });
    const notes = await testDb.notification.findMany({ orderBy: { type: "asc" } });
    expect(notes.map((n) => [n.type, n.userId])).toEqual([
      ["GRACE_EXPIRED_HOST", s.host.user.id],
      ["GRACE_EXPIRED_RENTER", s.renter.user.id],
    ]);
    expect((await events(s.id)).map((e) => e.type)).toEqual(["OVERSTAY_STARTED"]);
  });

  test("a job for a superseded endAt is a no-op", async () => {
    const s = await seed({ start: -120, end: -11, status: "GRACE_PERIOD", checkedIn: true });
    await sessions.graceExpired({ bookingId: s.id, endAt: at(-60).toISOString() });
    await sessions.startGrace({ bookingId: s.id, endAt: at(-60).toISOString() });
    expect(await status(s.id)).toBe("GRACE_PERIOD");
    expect(await testDb.overstayIncident.count()).toBe(0);
  });

  test("checkout during OVERSTAY → COMPLETED and the incident resolves as departed, no fee", async () => {
    const s = await seed({ start: -120, end: -11, status: "GRACE_PERIOD", checkedIn: true });
    await sessions.graceExpired(graceJob(s.booking));
    const res = await checkOut(s.id, s.renter.cookie);
    expect(res.status).toBe(200);
    expect(await status(s.id)).toBe("COMPLETED");
    const incident = await testDb.overstayIncident.findFirstOrThrow({ where: { bookingId: s.id } });
    expect(incident).toMatchObject({ status: "RESOLVED", resolution: "departed" });
    expect(incident.resolvedAt).not.toBeNull();
    expect(await testDb.payment.count()).toBe(0);
    expect(await testDb.ledgerEntry.count()).toBe(0);
  });
});

/** Settles the extension order like a verified webhook would. */
async function pay(orderId: string, paymentId = `pay_${randomUUID().slice(0, 8)}`) {
  const o = fake.orders.get(orderId)!;
  return settlePayment(
    {
      providerPaymentId: paymentId,
      providerOrderId: orderId,
      amountPaise: o.amount,
      currency: o.currency,
    },
    "webhook",
  );
}

describe("extensions", () => {
  test("conflicting with the next booking → 409", async () => {
    const s = await seed({ start: -30, end: 90, status: "ACTIVE", checkedIn: true });
    const other = await seedSession();
    await testDb.booking.create({
      data: {
        listingId: s.listing.id,
        renterId: other.user.id,
        rentalType: "HOURLY",
        startAt: at(120),
        endAt: at(180),
        blockedUntil: at(180),
        status: "CONFIRMED",
        subtotalPaise: 1,
        commissionPaise: 0,
        hostEarningsPaise: 1,
        totalPaise: 1,
      },
    });
    const res = await extend(s.id, s.renter.cookie, at(150));
    expect(res.status).toBe(409);
    expect((await res.json()).error.details.reason).toBe("slot_unavailable");
    // Up to the next booking is fine.
    expect((await extend(s.id, s.renter.cookie, at(120))).status).toBe(200);
  });

  test("paid: endAt moves only after settlement, totals and ledger take the delta, reminders reschedule", async () => {
    const s = await seed({ start: -30, end: 90, status: "ACTIVE", checkedIn: true });
    await sessions.scheduleSessionJobs(s.id);
    const oldEnd = s.booking.endAt.toISOString();
    const key = randomUUID();
    const res = await extend(s.id, s.renter.cookie, at(150), key);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ requiresPayment: true, quote: { total: { paise: 50_000 } } });
    expect(body.payment.amount.paise).toBe(50_000);
    expect(body.booking.endAt).toBe(oldEnd); // not yet

    // Same Idempotency-Key → same response, no second quote or order.
    const again = await extend(s.id, s.renter.cookie, at(150), key);
    expect((await again.json()).quote.id).toBe(body.quote.id);
    expect(fake.orders.size).toBe(1);

    const r = await pay(body.payment.orderId, "pay_ext_1");
    expect(r.outcome).toBe("extension_applied");
    expect((await pay(body.payment.orderId, "pay_ext_1")).outcome).toBe("already_settled");

    const b = await testDb.booking.findUniqueOrThrow({ where: { id: s.id } });
    expect(b.endAt.getTime()).toBe(at(150).getTime());
    expect(b.blockedUntil.getTime()).toBe(at(150).getTime());
    expect(b).toMatchObject({
      status: "ACTIVE",
      totalPaise: 150_000,
      subtotalPaise: 150_000,
      commissionPaise: 15_000,
      hostEarningsPaise: 135_000,
    });
    const ledger = await testDb.ledgerEntry.findMany({ where: { reference: "pay_ext_1" } });
    expect(Object.fromEntries(ledger.map((l) => [l.account, l.amountPaise]))).toEqual({
      RENTER_PAYMENT: 50_000,
      PLATFORM_COMMISSION: 5_000,
      HOST_EARNINGS: 45_000,
    });
    expect((await events(s.id)).map((e) => e.type)).toEqual(["EXTENDED"]);

    const newEnd = b.endAt.toISOString();
    const keyed = async (prefix: string) =>
      (
        await testDb.notification.findMany({
          where: { idempotencyKey: { startsWith: prefix } },
          select: { status: true },
        })
      ).map((n) => n.status);
    expect(await keyed(`session:${s.id}:ending:${oldEnd}`)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(await keyed(`session:${s.id}:ending:${newEnd}`)).toEqual(["PENDING", "PENDING"]);
    expect(await testDb.notification.count({ where: { type: "EXTENSION_OUTCOME" } })).toBe(1);
    expect(
      await testDb.notification.count({
        where: { type: "EXTENSION_REQUESTED", userId: s.host.user.id },
      }),
    ).toBe(1);
    expect(
      await testDb.job.count({
        where: { idempotencyKey: `sessions.graceExpired:${s.id}:${newEnd}` },
      }),
    ).toBe(1);

    // The old end's grace jobs no longer act.
    await sessions.startGrace({ bookingId: s.id, endAt: oldEnd });
    expect(await status(s.id)).toBe("ACTIVE");
  });

  test("slot taken before settlement → capture refunded, booking unchanged", async () => {
    const s = await seed({ start: -30, end: 90, status: "ACTIVE", checkedIn: true });
    const body = await (await extend(s.id, s.renter.cookie, at(150))).json();
    const other = await seedSession();
    await testDb.booking.create({
      data: {
        listingId: s.listing.id,
        renterId: other.user.id,
        rentalType: "HOURLY",
        startAt: at(120),
        endAt: at(180),
        blockedUntil: at(180),
        status: "CONFIRMED",
        subtotalPaise: 1,
        commissionPaise: 0,
        hostEarningsPaise: 1,
        totalPaise: 1,
      },
    });
    const r = await pay(body.payment.orderId);
    expect(r.outcome).toBe("refund_extension_unavailable");
    const b = await testDb.booking.findUniqueOrThrow({ where: { id: s.id } });
    expect(b.endAt.getTime()).toBe(at(90).getTime());
    expect(b.totalPaise).toBe(100_000);
    const p = await testDb.payment.findFirstOrThrow({
      where: { providerOrderId: body.payment.orderId },
    });
    expect(p.status).toBe("CAPTURED_UNFULFILLED");
    expect(await testDb.refund.count({ where: { paymentId: p.id, amountPaise: 50_000 } })).toBe(1);
    const outcome = await testDb.notification.findFirstOrThrow({
      where: { type: "EXTENSION_OUTCOME" },
    });
    expect(outcome.payload).toMatchObject({ approved: false });
  });

  test("paid during GRACE_PERIOD → back to ACTIVE, and the new end's grace jobs work", async () => {
    const s = await seed({ start: -120, end: -2, status: "GRACE_PERIOD", checkedIn: true });
    const body = await (await extend(s.id, s.renter.cookie, at(60))).json();
    expect((await pay(body.payment.orderId)).outcome).toBe("extension_applied");
    const b = await testDb.booking.findUniqueOrThrow({ where: { id: s.id } });
    expect(b.status).toBe("ACTIVE");
    await sessions.graceExpired({ bookingId: s.id, endAt: s.booking.endAt.toISOString() });
    expect(await status(s.id)).toBe("ACTIVE");
    await sessions.startGrace(graceJob(b));
    expect(await status(s.id)).toBe("GRACE_PERIOD");
    await sessions.graceExpired(graceJob(b));
    expect(await status(s.id)).toBe("OVERSTAY");
  });

  test("OVERSTAY can't be extended; host can't extend", async () => {
    const s = await seed({ start: -120, end: -30, status: "OVERSTAY", checkedIn: true });
    expect((await extend(s.id, s.renter.cookie, at(60))).status).toBe(409);
    const t = await seed({ start: -30, end: 60, status: "ACTIVE", checkedIn: true });
    expect((await extend(t.id, t.host.cookie, at(120))).status).toBe(403);
  });

  test("host earnings count both the booking and the extension capture once each", async () => {
    const s = await seed({ start: -30, end: 90, status: "ACTIVE", checkedIn: true });
    await testDb.payment.create({
      data: {
        bookingId: s.id,
        providerOrderId: "order_orig",
        providerPaymentId: "pay_orig",
        amountPaise: 100_000,
        status: "SUCCEEDED",
      },
    });
    await testDb.ledgerEntry.createMany({
      data: [
        { bookingId: s.id, account: "RENTER_PAYMENT", amountPaise: 100_000, reference: "pay_orig" },
        {
          bookingId: s.id,
          account: "PLATFORM_COMMISSION",
          amountPaise: 10_000,
          reference: "pay_orig",
        },
        { bookingId: s.id, account: "HOST_EARNINGS", amountPaise: 90_000, reference: "pay_orig" },
      ],
    });
    const body = await (await extend(s.id, s.renter.cookie, at(150))).json();
    expect((await pay(body.payment.orderId)).outcome).toBe("extension_applied");
    const [e] = await bookingEarnings({ bookingIds: [s.id] });
    expect(e).toMatchObject({ hostEarnings: 135_000, commission: 15_000, gross: 150_000 });
  });
});

describe("incidents", () => {
  const cloud = "parkshare-test";
  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = cloud;
  });

  test("host evidence updates the system-opened incident and notifies the renter; support resolves it", async () => {
    const s = await seed({ start: -120, end: -11, status: "GRACE_PERIOD", checkedIn: true });
    await sessions.graceExpired(graceJob(s.booking));
    const url = `https://res.cloudinary.com/${cloud}/image/upload/v1/listings/${s.listing.id}/${randomUUID()}?_a=BAMAROZY0`;
    const res = await post(incidentRoute, "incidents", s.id, s.host.cookie, {
      kind: "OVERSTAY",
      note: "Car still in bay",
      evidenceUrls: [url],
    });
    expect(res.status).toBe(201);
    const inc = await res.json();
    expect(inc).toMatchObject({
      status: "OPEN",
      reportedById: s.host.user.id,
      evidenceUrls: [url],
    });
    expect(await testDb.overstayIncident.count()).toBe(1);
    expect(
      await testDb.notification.count({
        where: {
          userId: s.renter.user.id,
          type: "INCIDENT_REPORTED",
          idempotencyKey: { startsWith: `booking:${s.id}:incident:` },
        },
      }),
    ).toBe(1);

    const admin = await seedSession(["ADMIN"]);
    const resolved = await sessions.resolveIncident(
      admin.user.id,
      inc.id,
      "Vehicle moved",
      "Host confirmed by phone",
    );
    expect(resolved.status).toBe("RESOLVED");
    expect(await status(s.id)).toBe("COMPLETED");
    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { action: "incident.resolved", targetId: inc.id },
    });
    expect(audit).toMatchObject({ actorId: admin.user.id, reason: "Host confirmed by phone" });
  });

  test("evidence from elsewhere → 422; the renter can't report → 403", async () => {
    const s = await seed({ start: -60, end: 30, status: "ACTIVE", checkedIn: true });
    const bad = await post(incidentRoute, "incidents", s.id, s.host.cookie, {
      kind: "BLOCKED_ACCESS",
      evidenceUrls: ["https://example.com/x.jpg"],
    });
    expect(bad.status).toBe(422);
    // A Cloudinary fetch of a remote URL that merely mentions our folder isn't our upload.
    const fetched = await post(incidentRoute, "incidents", s.id, s.host.cookie, {
      kind: "OVERSTAY",
      evidenceUrls: [
        `https://res.cloudinary.com/${cloud}/image/fetch/https://evil.example/listings/${s.listing.id}/x.jpg`,
      ],
    });
    expect(fetched.status).toBe(422);
    const renter = await post(incidentRoute, "incidents", s.id, s.renter.cookie, {
      kind: "OVERSTAY",
    });
    expect(renter.status).toBe(403);
  });
});

test("a non-party gets 404 on every session action", async () => {
  const s = await seed({ start: -5, end: 60 });
  const stranger = await seedSession();
  expect((await checkIn(s.id, stranger.cookie)).status).toBe(404);
  expect((await checkIn(s.id, stranger.cookie, { asHost: true })).status).toBe(404);
  expect((await checkOut(s.id, stranger.cookie)).status).toBe(404);
  expect((await extend(s.id, stranger.cookie, at(120))).status).toBe(404);
  expect(
    (await post(incidentRoute, "incidents", s.id, stranger.cookie, { kind: "OVERSTAY" })).status,
  ).toBe(404);
});
