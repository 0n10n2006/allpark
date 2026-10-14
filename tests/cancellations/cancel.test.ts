import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";
import { req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST: cancelRoute } = await import("@/app/api/bookings/[id]/cancel/route");
const { applyRefundOutcome } = await import("@/server/payments/refunds");
const { params, seedBooking } = await import("./fixtures");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const cancel = (cookie: string, id: string, key: string = randomUUID(), body: object = {}) =>
  cancelRoute(
    req(`/api/bookings/${id}/cancel`, {
      method: "POST",
      cookie,
      body,
      headers: { "idempotency-key": key },
    }),
    params(id),
  );

const refundsOf = (bookingId: string) =>
  testDb.refund.findMany({ where: { payment: { bookingId } } });

describe("POST /api/bookings/:id/cancel", () => {
  test("renter, outside the free window → CANCELLED with a full PENDING refund", async () => {
    const { booking, renter } = await seedBooking({ startInHours: 5 });
    const res = await cancel(renter.cookie, booking.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "CANCELLED", refundStatus: "PENDING" });
    const [refund] = await refundsOf(booking.id);
    expect(refund).toMatchObject({ amountPaise: 100_000, reason: "renter_cancellation" });
    expect(await testDb.job.count({ where: { type: "payments.processRefund" } })).toBe(1);
  });

  test("renter, DAILY 10 h before start → 50% tier", async () => {
    const { booking, renter } = await seedBooking({ rentalType: "DAILY", startInHours: 10 });
    expect((await cancel(renter.cookie, booking.id)).status).toBe(200);
    expect((await refundsOf(booking.id)).map((r) => r.amountPaise)).toEqual([50_000]);
  });

  test("renter, inside the no-refund window → CANCELLED, no refund row", async () => {
    const { booking, renter } = await seedBooking({ startInHours: 1 });
    const res = await cancel(renter.cookie, booking.id);
    expect((await res.json()).status).toBe("CANCELLED");
    expect(await refundsOf(booking.id)).toEqual([]);
  });

  test("host cancel → full refund regardless of tier, plus a host-cancellation audit", async () => {
    const { booking, host } = await seedBooking({ startInHours: 1 });
    const res = await cancel(host.cookie, booking.id, randomUUID(), { reason: "Gate broken" });
    expect(res.status).toBe(200);
    const [refund] = await refundsOf(booking.id);
    expect(refund).toMatchObject({ amountPaise: 100_000, reason: "host_cancellation" });
    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { action: "booking.host_cancellation", targetId: booking.id },
    });
    expect(audit).toMatchObject({ actorId: host.id, reason: "Gate broken" });
    const notices = await testDb.notification.findMany({ where: { type: "CANCELLATION_UPDATE" } });
    expect(notices.map((n) => n.userId).sort()).toEqual([booking.renterId, host.id].sort());
    expect(notices[0].payload).toMatchObject({ bookingId: booking.id, cancelledBy: "HOST" });
    expect(
      (await testDb.booking.findUniqueOrThrow({ where: { id: booking.id } })).cancellationReason,
    ).toBe("Gate broken");
  });

  test("cancelling twice is idempotent: same key replays, a new key changes nothing", async () => {
    const { booking, renter } = await seedBooking();
    const first = await cancel(renter.cookie, booking.id, "k1");
    const replay = await cancel(renter.cookie, booking.id, "k1");
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    const again = await cancel(renter.cookie, booking.id, "k2");
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe("CANCELLED");
    expect(await refundsOf(booking.id)).toHaveLength(1);
  });

  test("cancellation state is independent of the refund state machine", async () => {
    const { booking, renter } = await seedBooking();
    await cancel(renter.cookie, booking.id);
    const [refund] = await refundsOf(booking.id);
    expect(refund.status).toBe("PENDING");
    await testDb.$transaction((tx) => applyRefundOutcome(tx, refund.id, "failed", "rfnd_1"));
    const b = await testDb.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.status).toBe("CANCELLED");
    expect((await testDb.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
      "FAILED",
    );
  });

  test("the refund never exceeds captured minus prior refunds", async () => {
    const { booking, host, payment } = await seedBooking();
    await testDb.refund.create({
      data: {
        paymentId: payment!.id,
        amountPaise: 70_000,
        reason: "goodwill",
        idempotencyKey: randomUUID(),
      },
    });
    expect((await cancel(host.cookie, booking.id)).status).toBe(200);
    const refunds = await refundsOf(booking.id);
    expect(refunds.find((r) => r.reason === "host_cancellation")!.amountPaise).toBe(30_000);
    expect(refunds.reduce((s, r) => s + r.amountPaise, 0)).toBe(100_000);
  });

  test("PENDING_PAYMENT → the hold is cancelled, no refund", async () => {
    const { booking, renter } = await seedBooking({ status: "PENDING_PAYMENT" });
    const res = await cancel(renter.cookie, booking.id);
    expect((await res.json()).status).toBe("CANCELLED");
    expect(await refundsOf(booking.id)).toEqual([]);
  });

  test.each(["ACTIVE", "GRACE_PERIOD", "OVERSTAY", "DISPUTED", "COMPLETED"] as const)(
    "%s → 409 not_cancellable",
    async (status) => {
      const { booking, renter } = await seedBooking({ status });
      const res = await cancel(renter.cookie, booking.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error.details.reason).toBe("not_cancellable");
    },
  );

  test("a non-party gets 404 and nothing changes", async () => {
    const { booking } = await seedBooking();
    const stranger = await seedSession();
    expect((await cancel(stranger.cookie, booking.id)).status).toBe(404);
    expect((await testDb.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      "CONFIRMED",
    );
  });

  test("pending reminders for the booking are cancelled", async () => {
    const { booking, renter } = await seedBooking();
    const reminder = await testDb.notification.create({
      data: {
        userId: renter.user.id,
        type: "SESSION_ENDING",
        payload: { bookingId: booking.id },
        scheduledAt: booking.endAt,
        idempotencyKey: `booking:${booking.id}:ending:30:${booking.endAt.toISOString()}`,
      },
    });
    await cancel(renter.cookie, booking.id);
    expect(
      (await testDb.notification.findUniqueOrThrow({ where: { id: reminder.id } })).status,
    ).toBe("CANCELLED");
  });
});

describe("bookings with a paid extension", () => {
  async function extended(opts: Parameters<typeof seedBooking>[0]) {
    const s = await seedBooking(opts);
    const ext = await testDb.payment.create({
      data: {
        bookingId: s.booking.id,
        providerOrderId: `order_${randomUUID()}`,
        providerPaymentId: `pay_${randomUUID()}`,
        amountPaise: 50_000,
        status: "SUCCEEDED",
        createdAt: new Date(Date.now() + 1000),
      },
    });
    return { ...s, ext };
  }
  const split = async (bookingId: string) =>
    Object.fromEntries((await refundsOf(bookingId)).map((r) => [r.paymentId, r.amountPaise]));

  test("full refund before start is split per payment, each within its own capture", async () => {
    const { booking, renter, payment, ext } = await extended({ startInHours: 5 });
    expect((await cancel(renter.cookie, booking.id)).status).toBe(200);
    expect(await split(booking.id)).toEqual({ [payment!.id]: 100_000, [ext.id]: 50_000 });
  });

  test("a partial tier is computed on everything paid and spills over in payment order", async () => {
    // DAILY 10 h before start: 50% of ₹1,500 = ₹750; the original has ₹600 left after a prior refund.
    const { booking, renter, payment, ext } = await extended({
      rentalType: "DAILY",
      startInHours: 10,
    });
    await testDb.refund.create({
      data: {
        paymentId: payment!.id,
        amountPaise: 40_000,
        reason: "earlier",
        idempotencyKey: randomUUID(),
        status: "SUCCEEDED",
      },
    });
    expect((await cancel(renter.cookie, booking.id)).status).toBe(200);
    const rows = await refundsOf(booking.id);
    const fromCancel = rows.filter((r) => r.reason === "renter_cancellation");
    expect(Object.fromEntries(fromCancel.map((r) => [r.paymentId, r.amountPaise]))).toEqual({
      [payment!.id]: 60_000,
      [ext.id]: 15_000,
    });
  });
});
