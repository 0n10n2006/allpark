import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";
import { noParams, req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const disputesRoute = await import("@/app/api/disputes/route");
const { GET: adminListRoute } = await import("@/app/api/admin/disputes/route");
const { GET: adminGetRoute } = await import("@/app/api/admin/disputes/[id]/route");
const { POST: resolveRoute } = await import("@/app/api/admin/disputes/[id]/resolve/route");
const { POST: cancelRoute } = await import("@/app/api/bookings/[id]/cancel/route");
const { params, seedBooking } = await import("../cancellations/fixtures");
const { seedQuote } = await import("../booking/fixtures");

beforeEach(async () => {
  await truncateAll();
  vi.stubEnv("CLOUDINARY_CLOUD_NAME", "parkshare-test");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => testDb.$disconnect());

const openDispute = (cookie: string, body: object) =>
  disputesRoute.POST(req("/api/disputes", { method: "POST", cookie, body }), noParams);
const report = (bookingId: string, extra: object = {}) => ({
  bookingId,
  category: "ACCESS_DENIED",
  description: "Gate was locked on arrival.",
  ...extra,
});
const resolve = (cookie: string, id: string, body: object) =>
  resolveRoute(
    req(`/api/admin/disputes/${id}/resolve`, { method: "POST", cookie, body }),
    params(id),
  );
const statusOf = async (id: string) =>
  (await testDb.booking.findUniqueOrThrow({ where: { id } })).status;

describe("POST /api/disputes", () => {
  test.each(["ACTIVE", "GRACE_PERIOD", "OVERSTAY"] as const)(
    "a dispute on a %s booking opens and moves the booking to DISPUTED",
    async (status) => {
      const { booking, renter } = await seedBooking({ status, startInHours: -1 });
      const res = await openDispute(renter.cookie, report(booking.id, { category: "OVERSTAY" }));
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ status: "OPEN", raisedById: renter.user.id });
      expect(await statusOf(booking.id)).toBe("DISPUTED");
    },
  );

  test.each(["CONFIRMED", "COMPLETED", "CANCELLED"] as const)(
    "a dispute on a %s booking is tracked without changing the booking",
    async (status) => {
      const { booking, host } = await seedBooking({ status });
      expect((await openDispute(host.cookie, report(booking.id))).status).toBe(201);
      expect(await statusOf(booking.id)).toBe(status);
    },
  );

  test("a second dispute on a DISPUTED booking is recorded; the booking stays DISPUTED", async () => {
    const { booking, renter, host } = await seedBooking({ status: "ACTIVE", startInHours: -1 });
    await openDispute(renter.cookie, report(booking.id));
    expect((await openDispute(host.cookie, report(booking.id))).status).toBe(201);
    expect(await testDb.dispute.count({ where: { bookingId: booking.id } })).toBe(2);
  });

  test("accepts every FR-10 case as a category", async () => {
    const { booking, renter } = await seedBooking();
    for (const category of [
      "ACCESS_DENIED",
      "SPACE_UNAVAILABLE",
      "INCORRECT_LISTING",
      "DUPLICATE_CHARGE",
      "BOOKING_FAILURE",
      "OVERSTAY",
    ])
      expect((await openDispute(renter.cookie, report(booking.id, { category }))).status).toBe(201);
  });

  test("a non-party gets 404", async () => {
    const { booking } = await seedBooking();
    const stranger = await seedSession();
    expect((await openDispute(stranger.cookie, report(booking.id))).status).toBe(404);
    expect(await testDb.dispute.count()).toBe(0);
  });

  test("evidence must come from our Cloudinary disputes folder for this booking", async () => {
    const { booking, renter } = await seedBooking();
    const ok = `https://res.cloudinary.com/parkshare-test/image/upload/v17/disputes/${booking.id}/abc_1.jpg`;
    for (const bad of [
      "https://evil.example/x.jpg",
      `https://res.cloudinary.com/other/image/upload/disputes/${booking.id}/a.jpg`,
      `https://res.cloudinary.com/parkshare-test/image/upload/disputes/${randomUUID()}/a.jpg`,
      `https://res.cloudinary.com/parkshare-test/image/upload/listings/${booking.id}/a.jpg`,
    ]) {
      const res = await openDispute(renter.cookie, report(booking.id, { evidenceUrls: [ok, bad] }));
      expect(res.status, bad).toBe(400);
    }
    const res = await openDispute(renter.cookie, report(booking.id, { evidenceUrls: [ok] }));
    expect(res.status).toBe(201);
    expect((await res.json()).evidenceUrls).toEqual([ok]);
  });

  test("is rate limited per user", async () => {
    const { booking, renter } = await seedBooking();
    for (let i = 0; i < 10; i++)
      expect((await openDispute(renter.cookie, report(booking.id))).status).toBe(201);
    expect((await openDispute(renter.cookie, report(booking.id))).status).toBe(429);
  });
});

describe("GET /api/disputes", () => {
  test("renter and host see the booking's disputes; others see none", async () => {
    const { booking, renter, host } = await seedBooking();
    await openDispute(renter.cookie, report(booking.id));
    const list = async (cookie: string) =>
      (await (await disputesRoute.GET(req("/api/disputes", { cookie }), noParams)).json()).items;
    expect(await list(renter.cookie)).toHaveLength(1);
    expect(await list(host.cookie)).toHaveLength(1);
    expect(await list((await seedSession()).cookie)).toEqual([]);
  });
});

describe("admin disputes", () => {
  async function disputed() {
    const seeded = await seedBooking({ status: "ACTIVE", startInHours: -1 });
    const res = await openDispute(seeded.renter.cookie, report(seeded.booking.id));
    const admin = await seedSession(["ADMIN"]);
    return { ...seeded, admin, disputeId: (await res.json()).id as string };
  }

  test("non-admins get 403 on every admin dispute route", async () => {
    const { renter, disputeId } = await disputed();
    const c = renter.cookie;
    expect((await adminListRoute(req("/api/admin/disputes", { cookie: c }), noParams)).status).toBe(
      403,
    );
    expect(
      (
        await adminGetRoute(
          req(`/api/admin/disputes/${disputeId}`, { cookie: c }),
          params(disputeId),
        )
      ).status,
    ).toBe(403);
    const body = {
      outcome: "RESOLVED",
      resolution: "Done",
      reason: "ok",
      bookingOutcome: "COMPLETED",
    };
    expect((await resolve(c, disputeId, body)).status).toBe(403);
  });

  test("resolve requires a reason", async () => {
    const { admin, disputeId } = await disputed();
    const res = await resolve(admin.cookie, disputeId, {
      outcome: "RESOLVED",
      resolution: "Refunded",
      bookingOutcome: "COMPLETED",
    });
    expect(res.status).toBe(400);
    expect(await testDb.dispute.findUniqueOrThrow({ where: { id: disputeId } })).toMatchObject({
      status: "OPEN",
    });
  });

  test("closing a DISPUTED booking's dispute requires a booking outcome", async () => {
    const { admin, disputeId } = await disputed();
    const res = await resolve(admin.cookie, disputeId, {
      outcome: "RESOLVED",
      resolution: "Refunded",
      reason: "Checked logs",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.details.reason).toBe("booking_outcome_required");
  });

  test("resolve writes the audit, refunds, closes the dispute, and completes the booking", async () => {
    const { admin, booking, disputeId } = await disputed();
    const res = await resolve(admin.cookie, disputeId, {
      outcome: "RESOLVED",
      resolution: "Gate was locked; partial refund.",
      reason: "Host confirmed the lock",
      refundPaise: 40_000,
      bookingOutcome: "COMPLETED",
    });
    expect(res.status).toBe(200);
    const { auditLogId } = await res.json();
    expect(await testDb.auditLog.findUniqueOrThrow({ where: { id: auditLogId } })).toMatchObject({
      actorId: admin.user.id,
      action: "dispute.resolved",
      targetType: "Dispute",
      targetId: disputeId,
      reason: "Host confirmed the lock",
    });
    expect(await testDb.dispute.findUniqueOrThrow({ where: { id: disputeId } })).toMatchObject({
      status: "RESOLVED",
      resolvedById: admin.user.id,
    });
    expect(await statusOf(booking.id)).toBe("COMPLETED");
    const refunds = await testDb.refund.findMany({ where: { payment: { bookingId: booking.id } } });
    expect(refunds.map((r) => [r.amountPaise, r.reason])).toEqual([[40_000, "dispute_resolution"]]);
    // FR-08: support decisions never charge the renter.
    expect(await testDb.payment.count({ where: { bookingId: booking.id } })).toBe(1);

    const again = await resolve(admin.cookie, disputeId, {
      outcome: "REJECTED",
      resolution: "No change",
      reason: "Second look",
    });
    expect(again.status).toBe(409);
  });

  test("a refund over the refundable amount is rejected and nothing changes", async () => {
    const { admin, booking, disputeId } = await disputed();
    const res = await resolve(admin.cookie, disputeId, {
      outcome: "RESOLVED",
      resolution: "Refund",
      reason: "Goodwill",
      refundPaise: 100_001,
      bookingOutcome: "CANCELLED",
    });
    expect(res.status).toBe(422);
    expect(await statusOf(booking.id)).toBe("DISPUTED");
  });

  test("a refund larger than the latest capture is split across the booking's payments (H1)", async () => {
    const { admin, booking, listing, renter, payment, disputeId } = await disputed();
    const extQuote = await seedQuote({
      listingId: listing.id,
      renterId: renter.user.id,
      vehicleId: null,
      startAt: booking.endAt,
      endAt: new Date(booking.endAt.getTime() + 3_600_000),
    });
    const ext = await testDb.payment.create({
      data: {
        bookingId: booking.id,
        extensionQuoteId: extQuote.id,
        providerOrderId: `order_${randomUUID()}`,
        providerPaymentId: `pay_${randomUUID()}`,
        amountPaise: 50_000,
        status: "SUCCEEDED",
        createdAt: new Date(Date.now() + 1000),
      },
    });
    const res = await resolve(admin.cookie, disputeId, {
      outcome: "RESOLVED",
      resolution: "Refund most of it",
      reason: "Gate never opened",
      refundPaise: 120_000,
      bookingOutcome: "CANCELLED",
    });
    expect(res.status).toBe(200);
    const refunds = await testDb.refund.findMany({ where: { payment: { bookingId: booking.id } } });
    expect(Object.fromEntries(refunds.map((r) => [r.paymentId, r.amountPaise]))).toEqual({
      [payment!.id]: 100_000,
      [ext.id]: 20_000,
    });
  });

  test("REJECTED with CANCELLED moves the booking to CANCELLED", async () => {
    const { admin, booking, disputeId } = await disputed();
    const res = await resolve(admin.cookie, disputeId, {
      outcome: "REJECTED",
      resolution: "Space was unusable; cancelling.",
      reason: "Photos show flooding",
      bookingOutcome: "CANCELLED",
    });
    expect(res.status).toBe(200);
    expect(await statusOf(booking.id)).toBe("CANCELLED");
  });

  test("queue filters and the timeline returns the linked records", async () => {
    const { admin, booking, disputeId, renter, host } = await disputed();
    // An unrelated cancelled booking with a refund, so its records must stay out.
    const other = await seedBooking();
    await cancelRoute(
      req(`/api/bookings/${other.booking.id}/cancel`, {
        method: "POST",
        cookie: other.renter.cookie,
        body: {},
        headers: { "idempotency-key": randomUUID() },
      }),
      params(other.booking.id),
    );
    await testDb.notification.create({
      data: {
        userId: renter.user.id,
        type: "BOOKING_CONFIRMED_RENTER",
        payload: { bookingId: booking.id },
        idempotencyKey: randomUUID(),
      },
    });
    await resolve(admin.cookie, disputeId, {
      outcome: "UNDER_REVIEW",
      resolution: "Looking into it",
      reason: "Triaged",
    });

    const list = await adminListRoute(
      req("/api/admin/disputes?disputeStatus=UNDER_REVIEW", { cookie: admin.cookie }),
      noParams,
    );
    const { items } = await list.json();
    expect(items.map((d: { id: string }) => d.id)).toEqual([disputeId]);
    expect(items[0].booking).toMatchObject({ id: booking.id, hostId: host.id });

    const res = await adminGetRoute(
      req(`/api/admin/disputes/${disputeId}`, { cookie: admin.cookie }),
      params(disputeId),
    );
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(t.payments.map((p: { bookingId: string }) => p.bookingId)).toEqual([booking.id]);
    expect(t.notifications.map((n: { type: string }) => n.type)).toEqual([
      "BOOKING_CONFIRMED_RENTER",
    ]);
    expect(t.auditLog.map((a: { action: string }) => a.action)).toEqual([
      "dispute.open",
      "booking.transition",
      "dispute.under_review",
    ]);
  });
});
