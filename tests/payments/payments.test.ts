import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";
import { req, seedSession } from "../http/helpers";
import { FakeProvider, signPayment, signWebhook } from "./fake-provider";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST: holdRoute } = await import("@/app/api/bookings/hold/route");
const { POST: orderRoute } = await import("@/app/api/payments/order/route");
const { POST: confirmRoute } = await import("@/app/api/bookings/[id]/confirm-payment/route");
const { POST: webhookRoute } = await import("@/app/api/webhooks/razorpay/route");
const { setPaymentProvider } = await import("@/server/payments/provider");
const { createRefund } = await import("@/server/payments/refunds");
const { reconcilePayments } = await import("@/server/payments/service");
const { runOnce } = await import("@/server/jobs");
const { MIN, ist, seedListing, seedQuote, seedVehicle } = await import("../booking/fixtures");

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
const key = () => ({ "idempotency-key": randomUUID() });

async function hold(listingId: string, start = "10:00", end = "12:00") {
  const renter = await seedSession();
  const vehicle = await seedVehicle(renter.user.id);
  const quote = await seedQuote({
    listingId,
    renterId: renter.user.id,
    vehicleId: vehicle.id,
    startAt: ist(start),
    endAt: ist(end),
  });
  const res = await holdRoute(
    req("/api/bookings/hold", {
      method: "POST",
      cookie: renter.cookie,
      body: { quoteId: quote.id },
      headers: key(),
    }),
    params(""),
  );
  expect(res.status).toBe(201);
  return { renter, bookingId: (await res.json()).id as string };
}

const createOrder = (cookie: string, bookingId: string, headers = key()) =>
  orderRoute(
    req("/api/payments/order", { method: "POST", cookie, body: { bookingId }, headers }),
    params(""),
  );

/** A held booking with a provider order. */
async function ordered() {
  const listing = await seedListing();
  const h = await hold(listing.id);
  const res = await createOrder(h.renter.cookie, h.bookingId);
  expect(res.status).toBe(201);
  const order = await res.json();
  return { ...h, listing, orderId: order.orderId as string, order };
}

const confirm = (cookie: string, bookingId: string, body: Record<string, string>) =>
  confirmRoute(
    req(`/api/bookings/${bookingId}/confirm-payment`, {
      method: "POST",
      cookie,
      body,
      headers: key(),
    }),
    params(bookingId),
  );
const callbackBody = (
  orderId: string,
  paymentId: string,
  sig = signPayment(orderId, paymentId),
) => ({
  razorpayOrderId: orderId,
  razorpayPaymentId: paymentId,
  razorpaySignature: sig,
});

function webhook(
  event: string,
  entity: Record<string, unknown>,
  opts: { eventId?: string; sig?: string } = {},
) {
  const kind = event.split(".")[0] === "order" ? "payment" : event.split(".")[0];
  const raw = JSON.stringify({
    entity: "event",
    event,
    payload: { [kind]: { entity } },
    created_at: 1_760_000_000,
  });
  return webhookRoute(
    new Request("http://localhost/api/webhooks/razorpay", {
      method: "POST",
      headers: {
        "x-razorpay-signature": opts.sig ?? signWebhook(raw),
        "x-razorpay-event-id": opts.eventId ?? `evt_${randomUUID()}`,
      },
      body: raw,
    }),
  );
}
const paymentEntity = (p: {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: string;
}) => ({
  id: p.id,
  order_id: p.orderId,
  amount: p.amount,
  currency: p.currency,
  status: p.status,
});

const status = async (id: string) =>
  (await testDb.booking.findUniqueOrThrow({ where: { id } })).status;
const ledger = (bookingId: string) => testDb.ledgerEntry.findMany({ where: { bookingId } });
const sum = (rows: { account: string; amountPaise: number }[], account: string) =>
  rows.filter((r) => r.account === account).reduce((a, r) => a + r.amountPaise, 0);

describe("POST /api/payments/order", () => {
  test("amount is the booking snapshot; a repeat reuses the open order", async () => {
    const { renter, bookingId, order } = await ordered();
    expect(order).toMatchObject({
      bookingId,
      provider: "razorpay",
      keyId: "rzp_test_fake",
      amount: { paise: 100_000, currency: "INR" },
    });
    const again = await (await createOrder(renter.cookie, bookingId)).json();
    expect(again.orderId).toBe(order.orderId);
    expect(fake.orders.size).toBe(1);
    expect(await testDb.payment.findMany()).toMatchObject([
      { status: "ORDER_CREATED", amountPaise: 100_000 },
    ]);
  });

  test("someone else's booking → 404; expired hold → 409", async () => {
    const { bookingId } = await ordered();
    const other = await seedSession();
    expect((await createOrder(other.cookie, bookingId)).status).toBe(404);
    const listing = await seedListing();
    const h = await hold(listing.id);
    await testDb.booking.update({
      where: { id: h.bookingId },
      data: { holdExpiresAt: new Date(Date.now() - MIN) },
    });
    expect((await createOrder(h.renter.cookie, h.bookingId)).status).toBe(409);
  });

  test("no RAZORPAY env → 503 payments_not_configured", async () => {
    setPaymentProvider(null);
    const saved = process.env.RAZORPAY_KEY_ID;
    process.env.RAZORPAY_KEY_ID = "";
    try {
      const listing = await seedListing();
      const h = await hold(listing.id);
      const res = await createOrder(h.renter.cookie, h.bookingId);
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("payments_not_configured");
    } finally {
      process.env.RAZORPAY_KEY_ID = saved;
    }
  });
});

describe("confirm-payment callback", () => {
  test("invalid signature → 400 and no confirmation", async () => {
    const { renter, bookingId, orderId } = await ordered();
    const p = fake.pay(orderId);
    const res = await confirm(
      renter.cookie,
      bookingId,
      callbackBody(orderId, p.id, "ab".repeat(32)),
    );
    expect(res.status).toBe(400);
    expect(await status(bookingId)).toBe("PENDING_PAYMENT");
  });

  test("valid signature but the provider says failed → not confirmed", async () => {
    const { renter, bookingId, orderId } = await ordered();
    const p = fake.pay(orderId, { status: "failed" });
    const res = await confirm(renter.cookie, bookingId, callbackBody(orderId, p.id));
    expect(res.status).toBe(422);
    expect(await status(bookingId)).toBe("PENDING_PAYMENT");
    expect((await testDb.payment.findFirstOrThrow()).status).toBe("FAILED");
  });

  test("valid + captured → CONFIRMED; ledger GROSS = COMMISSION + HOST_EARNINGS", async () => {
    const { renter, bookingId, orderId } = await ordered();
    const p = fake.pay(orderId);
    const res = await confirm(renter.cookie, bookingId, callbackBody(orderId, p.id));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("CONFIRMED");
    const rows = await ledger(bookingId);
    expect(rows).toHaveLength(3);
    expect(sum(rows, "RENTER_PAYMENT")).toBe(100_000);
    expect(sum(rows, "PLATFORM_COMMISSION") + sum(rows, "HOST_EARNINGS")).toBe(100_000);
    expect(sum(rows, "HOST_EARNINGS")).toBe(90_000);
    expect(await testDb.payment.findFirstOrThrow()).toMatchObject({
      status: "SUCCEEDED",
      providerPaymentId: p.id,
    });
  });

  test("provider still pending → 202, not confirmed; the delayed webhook confirms later", async () => {
    const { renter, bookingId, orderId } = await ordered();
    const p = fake.pay(orderId, { status: "created" });
    const res = await confirm(renter.cookie, bookingId, callbackBody(orderId, p.id));
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("PENDING_PAYMENT");
    await webhook("payment.captured", paymentEntity({ ...p, status: "captured" }));
    expect(await status(bookingId)).toBe("CONFIRMED");
  });

  test("signed payload for another booking's order → 404", async () => {
    const a = await ordered();
    const b = await ordered();
    const p = fake.pay(a.orderId);
    const res = await confirm(b.renter.cookie, b.bookingId, callbackBody(a.orderId, p.id));
    expect(res.status).toBe(404);
    expect(await status(a.bookingId)).toBe("PENDING_PAYMENT");
  });
});

describe("POST /api/webhooks/razorpay", () => {
  test("bad signature → 400, nothing stored", async () => {
    const { bookingId, orderId } = await ordered();
    const p = fake.pay(orderId);
    const res = await webhook("payment.captured", paymentEntity(p), { sig: "00".repeat(32) });
    expect(res.status).toBe(400);
    expect(await testDb.providerEvent.count()).toBe(0);
    expect(await status(bookingId)).toBe("PENDING_PAYMENT");
  });

  test("a valid webhook confirms; the same event twice is stored and applied once", async () => {
    const { bookingId, orderId } = await ordered();
    const p = fake.pay(orderId);
    const eventId = "evt_same";
    expect((await webhook("payment.captured", paymentEntity(p), { eventId })).status).toBe(200);
    expect((await webhook("payment.captured", paymentEntity(p), { eventId })).status).toBe(200);
    // order.paid for the same payment has its own event id; settlement is still idempotent.
    expect((await webhook("order.paid", paymentEntity(p))).status).toBe(200);
    expect(await status(bookingId)).toBe("CONFIRMED");
    expect(await ledger(bookingId)).toHaveLength(3);
    expect(await testDb.providerEvent.count({ where: { eventId } })).toBe(1);
    expect(await testDb.refund.count()).toBe(0);
  });

  test("unknown event → 200, stored, no effect", async () => {
    const res = await webhook("payment.dispute.created", { id: "disp_1" });
    expect(res.status).toBe(200);
    expect(await testDb.providerEvent.count()).toBe(1);
  });

  test("payment.failed keeps the hold; a retry on the same order then confirms", async () => {
    const { bookingId, orderId } = await ordered();
    const bad = fake.pay(orderId, { status: "failed" });
    await webhook("payment.failed", paymentEntity(bad));
    expect(await status(bookingId)).toBe("PENDING_PAYMENT");
    expect((await testDb.payment.findFirstOrThrow()).status).toBe("FAILED");
    const good = fake.pay(orderId);
    await webhook("payment.captured", paymentEntity(good));
    expect(await status(bookingId)).toBe("CONFIRMED");
    expect(await testDb.payment.count()).toBe(1);
  });

  test("callback and webhook racing → exactly one settlement", async () => {
    const { renter, bookingId, orderId } = await ordered();
    const p = fake.pay(orderId);
    const [a, b] = await Promise.all([
      confirm(renter.cookie, bookingId, callbackBody(orderId, p.id)),
      webhook("payment.captured", paymentEntity(p)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await status(bookingId)).toBe("CONFIRMED");
    expect(await ledger(bookingId)).toHaveLength(3);
    expect(await testDb.auditLog.count({ where: { action: "payment.captured" } })).toBe(1);
  });
});

describe("late and duplicate payments", () => {
  test("payment after hold expiry with the slot taken → auto-refund, not confirmed", async () => {
    const { listing, bookingId, orderId } = await ordered();
    await testDb.booking.update({
      where: { id: bookingId },
      data: { holdExpiresAt: new Date(Date.now() - MIN) },
    });
    await hold(listing.id, "11:00", "13:00"); // expires ours and takes the slot
    const p = fake.pay(orderId);
    expect((await webhook("payment.captured", paymentEntity(p))).status).toBe(200);
    expect(await status(bookingId)).toBe("EXPIRED");
    const payment = await testDb.payment.findFirstOrThrow({ include: { refunds: true } });
    expect(payment.status).toBe("CAPTURED_UNFULFILLED");
    expect(payment.refunds).toMatchObject([
      { amountPaise: 100_000, reason: "booking_failed_after_payment", status: "PENDING" },
    ]);
    expect(await testDb.job.count({ where: { type: "payments.processRefund" } })).toBe(1);
  });

  test("payment after hold expiry with the slot still free → re-claimed and confirmed", async () => {
    const { bookingId, orderId } = await ordered();
    await testDb.booking.update({
      where: { id: bookingId },
      data: { holdExpiresAt: new Date(Date.now() - MIN), status: "EXPIRED" },
    });
    await webhook("payment.captured", paymentEntity(fake.pay(orderId)));
    expect(await status(bookingId)).toBe("CONFIRMED");
    expect(await testDb.refund.count()).toBe(0);
  });

  test("a second payment for a confirmed booking → refunded as a duplicate charge", async () => {
    const { bookingId, orderId } = await ordered();
    await webhook("payment.captured", paymentEntity(fake.pay(orderId)));
    const dup = fake.pay(orderId);
    await webhook("payment.captured", paymentEntity(dup));
    expect(await status(bookingId)).toBe("CONFIRMED");
    const row = await testDb.payment.findFirstOrThrow({
      where: { providerPaymentId: dup.id },
      include: { refunds: true },
    });
    expect(row.status).toBe("CAPTURED_UNFULFILLED");
    expect(row.refunds).toMatchObject([{ reason: "duplicate_charge", amountPaise: 100_000 }]);
    expect(sum(await ledger(bookingId), "HOST_EARNINGS")).toBe(90_000);
  });
});

describe("refunds", () => {
  async function capturedPayment() {
    const { bookingId, orderId } = await ordered();
    await webhook("payment.captured", paymentEntity(fake.pay(orderId)));
    return { bookingId, payment: await testDb.payment.findFirstOrThrow() };
  }
  const refund = (paymentId: string, amountPaise: number) =>
    createRefund({ paymentId, amountPaise, reason: "renter_cancelled", actorId: null }).then(
      (r) => r,
      (e) => e.status as number,
    );

  test("refunds over the remaining captured amount are rejected; failed ones free the balance", async () => {
    const { payment } = await capturedPayment();
    const first = await refund(payment.id, 60_000);
    expect(first).toMatchObject({ status: "PENDING" });
    expect(await refund(payment.id, 50_000)).toBe(422);
    expect(await refund(payment.id, 40_000)).toMatchObject({ status: "PENDING" });
    expect(await refund(payment.id, 1)).toBe(422);
    await testDb.refund.update({
      where: { id: (first as { id: string }).id },
      data: { status: "FAILED" },
    });
    expect(await refund(payment.id, 60_000)).toMatchObject({ status: "PENDING" });
  });

  test("job submits once; refund.processed webhook settles it with one REFUND ledger entry", async () => {
    const { bookingId, payment } = await capturedPayment();
    const r = await createRefund({
      paymentId: payment.id,
      amountPaise: 30_000,
      reason: "x",
      actorId: null,
    });
    await runOnce("test-worker");
    const submitted = await testDb.refund.findUniqueOrThrow({ where: { id: r.id } });
    expect(submitted.status).toBe("PROCESSING");
    expect(fake.refunds).toHaveLength(1);
    const entity = {
      id: submitted.providerRefundId,
      payment_id: payment.providerPaymentId,
      receipt: r.id,
    };
    await webhook("refund.processed", entity);
    await webhook("refund.processed", entity);
    expect((await testDb.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      "SUCCEEDED",
    );
    expect(sum(await ledger(bookingId), "REFUND")).toBe(30_000);
  });
});

test("reconcile settles a stale order whose webhook never arrived", async () => {
  const { bookingId, orderId } = await ordered();
  fake.pay(orderId);
  await testDb.payment.updateMany({ data: { createdAt: new Date(Date.now() - 31 * MIN) } });
  const summary = await reconcilePayments(fake);
  expect(summary).toMatchObject({ checked: 1, settled: 1 });
  expect(await status(bookingId)).toBe("CONFIRMED");
  expect(await testDb.auditLog.count({ where: { action: "payment.reconciled" } })).toBe(1);
});

describe("settlement wiring (T4.2, T4.3)", () => {
  test("a confirmed booking gets its session reminders and grace jobs", async () => {
    const { renter, bookingId, orderId } = await ordered();
    const p = fake.pay(orderId);
    expect((await confirm(renter.cookie, bookingId, callbackBody(orderId, p.id))).status).toBe(200);
    const { endAt } = await testDb.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(
      await testDb.job.count({
        where: { idempotencyKey: `sessions.startGrace:${bookingId}:${endAt.toISOString()}` },
      }),
    ).toBe(1);
    expect(await testDb.notification.count({ where: { type: "SESSION_ENDING" } })).toBe(2);
  });

  test("a confirmed MONTHLY booking creates its agreement", async () => {
    const { monthlyTermEnd } = await import("@/server/availability/service");
    const listing = await seedListing();
    const renter = await seedSession();
    const vehicle = await seedVehicle(renter.user.id);
    const quote = await seedQuote({
      listingId: listing.id,
      renterId: renter.user.id,
      vehicleId: vehicle.id,
      rentalType: "MONTHLY",
      startAt: ist("10:00"),
      endAt: monthlyTermEnd(ist("10:00")),
    });
    const held = await holdRoute(
      req("/api/bookings/hold", {
        method: "POST",
        cookie: renter.cookie,
        body: { quoteId: quote.id },
        headers: key(),
      }),
      params(""),
    );
    const bookingId = (await held.json()).id as string;
    const { orderId } = await (await createOrder(renter.cookie, bookingId)).json();
    const p = fake.pay(orderId);
    expect((await confirm(renter.cookie, bookingId, callbackBody(orderId, p.id))).status).toBe(200);
    const b = await testDb.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(b.monthlyAgreementId).not.toBeNull();
    const agreement = await testDb.monthlyAgreement.findUniqueOrThrow({
      where: { id: b.monthlyAgreementId! },
    });
    expect(agreement).toMatchObject({ status: "ACTIVE", currentTermEndAt: b.endAt });
  });
});
