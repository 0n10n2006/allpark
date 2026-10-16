import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";
import { noParams, req, seedSession } from "../http/helpers";
import { FakeProvider } from "../payments/fake-provider";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { GET: earningsRoute } = await import("@/app/api/host/earnings/route");
const { GET: hostPayoutsRoute } = await import("@/app/api/host/payouts/route");
const { GET: listRoute, POST: createRoute } = await import("@/app/api/admin/payouts/route");
const { POST: paidRoute } = await import("@/app/api/admin/payouts/[id]/mark-paid/route");
const { POST: failedRoute } = await import("@/app/api/admin/payouts/[id]/mark-failed/route");
const { GET: reconRoute } = await import("@/app/api/admin/payouts/reconciliation/route");
const { POST: holdRoute } = await import("@/app/api/bookings/hold/route");
const { POST: orderRoute } = await import("@/app/api/payments/order/route");
const { setPaymentProvider } = await import("@/server/payments/provider");
const { settlePayment } = await import("@/server/payments/service");
const { applyRefundOutcome, createRefund } = await import("@/server/payments/refunds");
const { HOUR, ist, seedListing, seedQuote, seedVehicle } = await import("../booking/fixtures");

let fake: FakeProvider;
let admin: Awaited<ReturnType<typeof seedSession>>;
beforeEach(async () => {
  await truncateAll();
  fake = new FakeProvider();
  setPaymentProvider(fake);
  admin = await seedSession(["RENTER", "ADMIN"]);
});
afterAll(async () => {
  setPaymentProvider(null);
  await testDb.$disconnect();
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const key = () => ({ "idempotency-key": randomUUID() });
const reason = "Weekly manual payout";

/** A host session that owns a fresh listing. */
async function hostWithListing() {
  const host = await seedSession(["RENTER", "HOST"]);
  const listing = await seedListing({ hostId: host.user.id });
  return { host, listing };
}

/**
 * A COMPLETED booking with the ledger T4.1 writes on confirm (total ₹1000, commission ₹100,
 * host ₹900). checkedOutAt defaults to two days ago, past the 24h hold-back.
 */
async function seedCompleted(listingId: string, day: number, checkedOutAgoMs = 48 * HOUR) {
  const renter = await seedSession();
  const b = await testDb.booking.create({
    data: {
      listingId,
      renterId: renter.user.id,
      rentalType: "HOURLY",
      startAt: ist("10:00", day),
      endAt: ist("12:00", day),
      blockedUntil: ist("12:00", day),
      status: "COMPLETED",
      subtotalPaise: 100_000,
      commissionPaise: 10_000,
      hostEarningsPaise: 90_000,
      totalPaise: 100_000,
      checkedOutAt: new Date(Date.now() - checkedOutAgoMs),
    },
  });
  const ref = `pay_${randomUUID().slice(0, 8)}`;
  await testDb.ledgerEntry.createMany({
    data: [
      { bookingId: b.id, account: "RENTER_PAYMENT", amountPaise: 100_000, reference: ref },
      { bookingId: b.id, account: "PLATFORM_COMMISSION", amountPaise: 10_000, reference: ref },
      { bookingId: b.id, account: "HOST_EARNINGS", amountPaise: 90_000, reference: ref },
    ],
  });
  return b.id;
}

const createPayout = (
  hostId: string,
  bookingIds: string[],
  headers = key(),
  cookie = admin.cookie,
) =>
  createRoute(
    req("/api/admin/payouts", {
      method: "POST",
      cookie,
      body: { hostId, bookingIds, reason },
      headers,
    }),
    noParams,
  );
const markPaid = (id: string, body: Record<string, string>, headers = key()) =>
  paidRoute(
    req(`/api/admin/payouts/${id}/mark-paid`, {
      method: "POST",
      cookie: admin.cookie,
      body,
      headers,
    }),
    params(id),
  );
const markFailed = (id: string, why = "Bank rejected the transfer") =>
  failedRoute(
    req(`/api/admin/payouts/${id}/mark-failed`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: why },
      headers: key(),
    }),
    params(id),
  );
const earnings = async (cookie: string) => {
  const res = await earningsRoute(req("/api/host/earnings", { cookie }), noParams);
  expect(res.status).toBe(200);
  return res.json();
};
const reconciliation = async () => {
  const res = await reconRoute(
    req("/api/admin/payouts/reconciliation", { cookie: admin.cookie }),
    noParams,
  );
  expect(res.status).toBe(200);
  return res.json();
};

describe("authorization", () => {
  test("a non-host gets 403 on earnings and host payouts", async () => {
    const renter = await seedSession(["RENTER"]);
    expect(
      (await earningsRoute(req("/api/host/earnings", { cookie: renter.cookie }), noParams)).status,
    ).toBe(403);
    expect(
      (await hostPayoutsRoute(req("/api/host/payouts", { cookie: renter.cookie }), noParams))
        .status,
    ).toBe(403);
  });

  test("a non-admin (even a host) gets 403 on every payout API", async () => {
    const { host, listing } = await hostWithListing();
    const id = await seedCompleted(listing.id, 7);
    expect((await createPayout(host.user.id, [id], key(), host.cookie)).status).toBe(403);
    expect(
      (await listRoute(req("/api/admin/payouts", { cookie: host.cookie }), noParams)).status,
    ).toBe(403);
    expect(
      (
        await reconRoute(
          req("/api/admin/payouts/reconciliation", { cookie: host.cookie }),
          noParams,
        )
      ).status,
    ).toBe(403);
    expect(await testDb.hostPayout.count()).toBe(0);
  });
});

describe("payout creation", () => {
  test("concurrent payouts over overlapping bookings: exactly one succeeds (FR-06 AC5)", async () => {
    const { host, listing } = await hostWithListing();
    const [a, b, c] = [
      await seedCompleted(listing.id, 7),
      await seedCompleted(listing.id, 8),
      await seedCompleted(listing.id, 9),
    ];
    const results = await Promise.all([
      createPayout(host.user.id, [a, b]),
      createPayout(host.user.id, [c, b]),
      createPayout(host.user.id, [b]),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    const winner = await results.find((r) => r.status === 201)!.json();
    expect(winner.amount.paise).toBe(90_000 * winner.bookingIds.length);
    expect(await testDb.hostPayout.count()).toBe(1);
    const claimed = await testDb.booking.findMany({ where: { hostPayoutId: winner.id } });
    expect(claimed.map((x) => x.id).sort()).toEqual([...winner.bookingIds].sort());
    // The loser's bookings that weren't taken are still payable.
    const loser = await results.find((r) => r.status === 409)!.json();
    expect(loser.error.details.reason).toBe("bookings_not_payable");
  });

  test("an already-paid booking can't be claimed again", async () => {
    const { host, listing } = await hostWithListing();
    const id = await seedCompleted(listing.id, 7);
    expect((await createPayout(host.user.id, [id])).status).toBe(201);
    expect((await createPayout(host.user.id, [id])).status).toBe(409);
  });

  test("rejects another host's booking, a booking inside the hold-back, and duplicate ids", async () => {
    const one = await hostWithListing();
    const two = await hostWithListing();
    const theirs = await seedCompleted(two.listing.id, 7);
    expect((await createPayout(one.host.user.id, [theirs])).status).toBe(409);
    const fresh = await seedCompleted(one.listing.id, 8, HOUR);
    expect((await createPayout(one.host.user.id, [fresh])).status).toBe(409);
    expect((await earnings(one.host.cookie)).bookings[0].status).toBe("PENDING");
    const ok = await seedCompleted(one.listing.id, 9);
    expect((await createPayout(one.host.user.id, [ok, ok])).status).toBe(400);
    expect(await testDb.hostPayout.count()).toBe(0);
  });

  test("the hold-back comes from the active policy (payoutHoldbackHours)", async () => {
    const { POLICY_DEFAULTS } = await import("@/config/policy");
    await testDb.policyVersion.create({
      data: {
        version: 2,
        policy: { ...POLICY_DEFAULTS, payoutHoldbackHours: 72 },
        effectiveAt: new Date(0),
      },
    });
    const { host, listing } = await hostWithListing();
    const twoDaysAgo = await seedCompleted(listing.id, 7);
    expect((await createPayout(host.user.id, [twoDaysAgo])).status).toBe(409);
    const fourDaysAgo = await seedCompleted(listing.id, 8, 96 * HOUR);
    expect((await createPayout(host.user.id, [fourDaysAgo])).status).toBe(201);
  });

  test("the same Idempotency-Key replays instead of creating a second payout", async () => {
    const { host, listing } = await hostWithListing();
    const id = await seedCompleted(listing.id, 7);
    const headers = key();
    const first = await createPayout(host.user.id, [id], headers);
    const again = await createPayout(host.user.id, [id], headers);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await testDb.hostPayout.count()).toBe(1);
  });
});

describe("mark-paid and mark-failed", () => {
  test("mark-paid requires a reason and a reference, then writes the ledger and an audit", async () => {
    const { host, listing } = await hostWithListing();
    const p = await (await createPayout(host.user.id, [await seedCompleted(listing.id, 7)])).json();
    expect((await markPaid(p.id, { reason })).status).toBe(400);
    expect((await markPaid(p.id, { providerReference: "UTR998877" })).status).toBe(400);
    const res = await markPaid(p.id, { providerReference: "UTR998877", reason });
    expect(res.status).toBe(200);
    const { auditLogId } = await res.json();
    const audit = await testDb.auditLog.findUniqueOrThrow({ where: { id: auditLogId } });
    expect(audit).toMatchObject({
      actorId: admin.user.id,
      action: "payout.mark_paid",
      targetId: p.id,
      reason,
    });
    const ledger = await testDb.ledgerEntry.findMany({ where: { account: "HOST_PAYOUT" } });
    expect(ledger).toMatchObject([
      { hostPayoutId: p.id, amountPaise: 90_000, reference: "UTR998877" },
    ]);
    // PAID is terminal: it can't be paid again or failed.
    expect((await markPaid(p.id, { providerReference: "UTR111", reason })).status).toBe(409);
    expect((await markFailed(p.id)).status).toBe(409);
    const e = await earnings(host.cookie);
    expect(e).toMatchObject({ paidOut: { paise: 90_000 }, payable: { paise: 0 } });
    const payouts = await (
      await hostPayoutsRoute(req("/api/host/payouts", { cookie: host.cookie }), noParams)
    ).json();
    expect(payouts.items).toMatchObject([{ status: "PAID", providerReference: "UTR998877" }]);
  });

  test("mark-failed releases the bookings so they can be paid again, and notifies host and admins", async () => {
    const { host, listing } = await hostWithListing();
    const ids = [await seedCompleted(listing.id, 7), await seedCompleted(listing.id, 8)];
    const p = await (await createPayout(host.user.id, ids)).json();
    expect((await earnings(host.cookie)).paidOut.paise).toBe(180_000);

    const res = await markFailed(p.id);
    expect(res.status).toBe(200);
    const audit = await testDb.auditLog.findUniqueOrThrow({
      where: { id: (await res.json()).auditLogId },
    });
    expect(audit).toMatchObject({
      action: "payout.mark_failed",
      reason: "Bank rejected the transfer",
    });
    expect(await testDb.booking.count({ where: { hostPayoutId: { not: null } } })).toBe(0);
    expect((await testDb.hostPayout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      "FAILED",
    );
    const notified = await testDb.notification.findMany({ select: { userId: true, type: true } });
    expect(notified).toEqual(
      expect.arrayContaining([
        { userId: host.user.id, type: "PAYOUT_FAILED_HOST" },
        { userId: admin.user.id, type: "PAYOUT_FAILED_ADMIN" },
      ]),
    );
    expect((await earnings(host.cookie)).payable.paise).toBe(180_000);

    const retry = await createPayout(host.user.id, ids);
    expect(retry.status).toBe(201);
    expect((await retry.json()).amount.paise).toBe(180_000);
  });
});

describe("earnings reconcile with the ledger (FR-06 AC6)", () => {
  /** A booking confirmed through T4.1's real settlement path; returns its captured payment. */
  async function confirmed(listingId: string, start: string, end: string) {
    const renter = await seedSession();
    const vehicle = await seedVehicle(renter.user.id);
    const quote = await seedQuote({
      listingId,
      renterId: renter.user.id,
      vehicleId: vehicle.id,
      startAt: ist(start),
      endAt: ist(end),
    });
    const hold = await holdRoute(
      req("/api/bookings/hold", {
        method: "POST",
        cookie: renter.cookie,
        body: { quoteId: quote.id },
        headers: key(),
      }),
      noParams,
    );
    const bookingId = (await hold.json()).id as string;
    const order = await orderRoute(
      req("/api/payments/order", {
        method: "POST",
        cookie: renter.cookie,
        body: { bookingId },
        headers: key(),
      }),
      noParams,
    );
    const { orderId } = await order.json();
    const pay = fake.pay(orderId);
    const r = await settlePayment(
      {
        providerPaymentId: pay.id,
        providerOrderId: orderId,
        amountPaise: pay.amount,
        currency: pay.currency,
      },
      "webhook",
    );
    expect(r.outcome).toBe("confirmed");
    return {
      bookingId,
      orderId,
      paymentId: (await testDb.payment.findFirstOrThrow({ where: { providerPaymentId: pay.id } }))
        .id,
    };
  }

  async function refund(paymentId: string, amountPaise: number) {
    const r = await createRefund({
      paymentId,
      amountPaise,
      reason: "renter_cancelled",
      actorId: null,
    });
    await testDb.$transaction((tx) =>
      applyRefundOutcome(tx, r.id, "processed", `rfnd_${randomUUID().slice(0, 8)}`),
    );
  }

  const complete = (bookingId: string) =>
    testDb.booking.update({
      where: { id: bookingId },
      data: { status: "COMPLETED", checkedOutAt: new Date(Date.now() - 48 * HOUR) },
    });

  test("confirm + partial refund + duplicate charge + payout", async () => {
    const { host, listing } = await hostWithListing();
    const a = await confirmed(listing.id, "10:00", "12:00");
    const b = await confirmed(listing.id, "13:00", "15:00");

    // 40% refund on A: the host bears 40% of ₹900.
    await refund(a.paymentId, 40_000);
    // A duplicate capture on B's order is auto-refunded; host earnings don't change.
    const dup = fake.pay(b.orderId);
    const d = await settlePayment(
      {
        providerPaymentId: dup.id,
        providerOrderId: b.orderId,
        amountPaise: dup.amount,
        currency: dup.currency,
      },
      "webhook",
    );
    expect(d.outcome).toBe("refund_duplicate_charge");
    const dupRefund = await testDb.refund.findFirstOrThrow({
      where: { payment: { providerPaymentId: dup.id } },
    });
    await testDb.$transaction((tx) =>
      applyRefundOutcome(tx, dupRefund.id, "processed", "rfnd_dup"),
    );

    let e = await earnings(host.cookie);
    expect(e).toMatchObject({
      gross: { paise: 200_000 },
      commission: { paise: 20_000 },
      refunds: { paise: 36_000 },
      hostEarnings: { paise: 144_000 },
      pending: { paise: 144_000 },
      payable: { paise: 0 },
      bookingCount: 2,
      payoutMode: "MANUAL",
    });
    expect(
      e.bookings.find((x: { bookingId: string }) => x.bookingId === a.bookingId).net.paise,
    ).toBe(54_000);

    await complete(a.bookingId);
    await complete(b.bookingId);
    e = await earnings(host.cookie);
    expect(e.payable.paise).toBe(144_000);

    const p = await (await createPayout(host.user.id, [a.bookingId, b.bookingId])).json();
    expect(p.amount.paise).toBe(144_000);
    expect((await markPaid(p.id, { providerReference: "UTR42", reason })).status).toBe(200);

    // The ledger agrees with the earnings view: HOST_EARNINGS − host refunds − payouts = 0 owed.
    const sums = await testDb.ledgerEntry.groupBy({ by: ["account"], _sum: { amountPaise: true } });
    const total = (acct: string) => sums.find((s) => s.account === acct)?._sum.amountPaise ?? 0;
    expect(total("HOST_EARNINGS")).toBe(180_000);
    expect(total("HOST_PAYOUT")).toBe(144_000);
    // REFUND rows: A's ₹400 (host-borne share ₹360) plus the ₹1000 duplicate, which isn't host-borne.
    expect(total("REFUND")).toBe(140_000);
    let r = await reconciliation();
    expect(r.discrepancies).toEqual([]);
    expect(r.hosts).toEqual([
      {
        hostId: host.user.id,
        hostEarningsPaise: 180_000,
        hostRefundsPaise: 36_000,
        paidOutPaise: 144_000,
        outstandingPaise: 0,
        unpaidBookingsPaise: 0,
        payablePaise: 0,
      },
    ]);

    // A refund after the host was paid shows up as a discrepancy for the admin.
    await refund(a.paymentId, 10_000);
    r = await reconciliation();
    expect(r.discrepancies).toEqual([
      {
        kind: "outstanding_mismatch",
        hostId: host.user.id,
        payoutId: null,
        expectedPaise: 0,
        actualPaise: -9_000,
      },
    ]);
  });

  test("partially-retained cancellation: host keeps retained share and is payable once after hold-back", async () => {
    const { host, listing } = await hostWithListing();
    const b = await confirmed(listing.id, "10:00", "12:00");

    // Renter cancels late with a 50% refund (₹500 refund on ₹1000 total)
    await refund(b.paymentId, 50_000);
    await testDb.booking.update({
      where: { id: b.bookingId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
      },
    });

    // Before hold-back: retained share (₹450 = 45,000 paise) is in PENDING, not PAYABLE
    let e = await earnings(host.cookie);
    expect(e.bookings[0].net.paise).toBe(45_000);
    expect(e.bookings[0].status).toBe("PENDING");
    expect(e.pending.paise).toBe(45_000);
    expect(e.payable.paise).toBe(0);

    // Attempting to create payout before holdback expires fails
    const prematureRes = await createPayout(host.user.id, [b.bookingId]);
    expect(prematureRes.status).toBe(409);

    // After hold-back expires (e.g. 48h after cancellation)
    await testDb.booking.update({
      where: { id: b.bookingId },
      data: {
        cancelledAt: new Date(Date.now() - 48 * HOUR),
      },
    });

    e = await earnings(host.cookie);
    expect(e.bookings[0].status).toBe("PAYABLE");
    expect(e.payable.paise).toBe(45_000);
    expect(e.pending.paise).toBe(0);

    // Host retained share is payable and claimed
    const pRes = await createPayout(host.user.id, [b.bookingId]);
    expect(pRes.status).toBe(201);
    const p = await pRes.json();
    expect(p.amount.paise).toBe(45_000);

    // No-double-payout guarantee: cannot be claimed a second time
    const dupRes = await createPayout(host.user.id, [b.bookingId]);
    expect(dupRes.status).toBe(409);

    // Mark paid and verify final state
    expect((await markPaid(p.id, { providerReference: "UTR_CANCEL_RETAINED", reason })).status).toBe(200);
    e = await earnings(host.cookie);
    expect(e.bookings[0].status).toBe("PAID");
    expect(e.paidOut.paise).toBe(45_000);
    expect(e.payable.paise).toBe(0);
    expect(e.pending.paise).toBe(0);
  });
});
