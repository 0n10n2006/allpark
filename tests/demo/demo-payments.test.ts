import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";
import { req, seedSession } from "../http/helpers";
import { seedListing, seedQuote, seedVehicle, ist } from "../booking/fixtures";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST: holdRoute } = await import("@/app/api/bookings/hold/route");
const { POST: orderRoute } = await import("@/app/api/payments/order/route");
const { POST: confirmRoute } = await import("@/app/api/bookings/[id]/confirm-payment/route");
const { getPaymentProvider } = await import("@/server/payments/provider");
const { DemoProvider, computeDemoPaymentSignature, DEMO_KEY_ID } = await import(
  "@/server/payments/demo-provider"
);

beforeEach(async () => {
  await truncateAll();
  vi.unstubAllEnvs();
  vi.stubEnv("DEMO_MODE", "1");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RAZORPAY_KEY_ID", "");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "");
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await testDb.$disconnect();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const key = () => ({ "idempotency-key": randomUUID() });

async function setupHold() {
  const listing = await seedListing();
  const renter = await seedSession();
  const vehicle = await seedVehicle(renter.user.id);
  const quote = await seedQuote({
    listingId: listing.id,
    renterId: renter.user.id,
    vehicleId: vehicle.id,
    startAt: ist("10:00"),
    endAt: ist("12:00"),
  });
  const holdRes = await holdRoute(
    req("/api/bookings/hold", {
      method: "POST",
      cookie: renter.cookie,
      body: { quoteId: quote.id },
      headers: key(),
    }),
    params(""),
  );
  expect(holdRes.status).toBe(201);
  const booking = await holdRes.json();
  return { renter, listing, quote, booking };
}

describe("DemoProvider and simulated payment settlement", () => {
  test("getPaymentProvider returns DemoProvider in demo mode when RAZORPAY_* keys are absent", () => {
    const provider = getPaymentProvider();
    expect(provider).toBeInstanceOf(DemoProvider);
    expect(provider?.keyId).toBe(DEMO_KEY_ID);
  });

  test("createOrder generates order_demo_* id and saves payment row", async () => {
    const { renter, booking } = await setupHold();
    const orderRes = await orderRoute(
      req("/api/payments/order", {
        method: "POST",
        cookie: renter.cookie,
        body: { bookingId: booking.id },
        headers: key(),
      }),
      params(""),
    );
    expect(orderRes.status).toBe(201);
    const order = await orderRes.json();
    expect(order.orderId).toMatch(/^order_demo_/);
    expect(order.keyId).toBe(DEMO_KEY_ID);
    expect(order.amount.paise).toBe(booking.total.paise);

    const paymentRow = await testDb.payment.findFirst({
      where: { bookingId: booking.id, providerOrderId: order.orderId },
    });
    expect(paymentRow).not.toBeNull();
    expect(paymentRow?.status).toBe("ORDER_CREATED");
  });

  test("demo payment confirmation goes through settlement: sets CONFIRMED and creates ledger rows", async () => {
    const { renter, booking } = await setupHold();

    // 1. Create order
    const orderRes = await orderRoute(
      req("/api/payments/order", {
        method: "POST",
        cookie: renter.cookie,
        body: { bookingId: booking.id },
        headers: key(),
      }),
      params(""),
    );
    const order = await orderRes.json();

    // 2. Compute demo signature
    const paymentId = `pay_demo_${order.orderId}_${randomUUID().slice(0, 8)}`;
    const signature = computeDemoPaymentSignature(order.orderId, paymentId);

    // 3. Confirm payment
    const confirmRes = await confirmRoute(
      req(`/api/bookings/${booking.id}/confirm-payment`, {
        method: "POST",
        cookie: renter.cookie,
        body: {
          razorpayOrderId: order.orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
        },
        headers: key(),
      }),
      params(booking.id),
    );

    expect(confirmRes.status).toBe(200);
    const confirmedBooking = await confirmRes.json();
    expect(confirmedBooking.status).toBe("CONFIRMED");

    // Verify DB state: booking is CONFIRMED and has access details
    const dbBooking = await testDb.booking.findUnique({ where: { id: booking.id } });
    expect(dbBooking?.status).toBe("CONFIRMED");

    // Verify payment was marked SUCCEEDED
    const dbPayment = await testDb.payment.findFirst({ where: { providerOrderId: order.orderId } });
    expect(dbPayment?.status).toBe("SUCCEEDED");

    // Verify ledger rows were created by settleTx
    const ledgerRows = await testDb.ledgerEntry.findMany({ where: { bookingId: booking.id } });
    expect(ledgerRows.length).toBeGreaterThan(0);
    expect(ledgerRows.some((l) => l.account === "RENTER_PAYMENT")).toBe(true);
  });

  test("demo simulated failure marks payment FAILED and throws 422 payment_failed", async () => {
    const { renter, booking } = await setupHold();

    const orderRes = await orderRoute(
      req("/api/payments/order", {
        method: "POST",
        cookie: renter.cookie,
        body: { bookingId: booking.id },
        headers: key(),
      }),
      params(""),
    );
    const order = await orderRes.json();

    const paymentId = `pay_demo_failed_${order.orderId}_${randomUUID().slice(0, 8)}`;
    const signature = computeDemoPaymentSignature(order.orderId, paymentId);

    const confirmRes = await confirmRoute(
      req(`/api/bookings/${booking.id}/confirm-payment`, {
        method: "POST",
        cookie: renter.cookie,
        body: {
          razorpayOrderId: order.orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
        },
        headers: key(),
      }),
      params(booking.id),
    );

    expect(confirmRes.status).toBe(422);
    const body = await confirmRes.json();
    expect(body.error.details?.reason).toBe("payment_failed");

    // Hold is still PENDING_PAYMENT so renter can retry
    const dbBooking = await testDb.booking.findUnique({ where: { id: booking.id } });
    expect(dbBooking?.status).toBe("PENDING_PAYMENT");

    // Payment row is marked FAILED
    const dbPayment = await testDb.payment.findFirst({ where: { providerOrderId: order.orderId } });
    expect(dbPayment?.status).toBe("FAILED");
  });

  test("demo refunds succeed immediately with status processed", async () => {
    const provider = getPaymentProvider()!;
    const refund = await provider.refund({
      paymentId: "pay_demo_test",
      amountPaise: 5000,
      receipt: "rcpt_1",
      notes: {},
    });
    expect(refund.status).toBe("processed");
    expect(refund.id).toMatch(/^rfnd_demo_/);

    const fetched = await provider.fetchRefund("pay_demo_test", "rcpt_1");
    expect(fetched?.id).toBe(refund.id);
    expect(fetched?.status).toBe("processed");
  });
});
