import { z } from "zod";
import type { CreatePaymentOrderResponse, RazorpayWebhookBody } from "@/contracts";
import type { Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { confirmHeldBooking, reclaimForPayment, transition } from "@/server/bookings/state";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { enqueue } from "@/server/jobs";
import { onMonthlyConfirmed } from "@/server/monthly/service";
import { notify } from "@/server/notifications";
import { log } from "./log";
import { sessionHooks } from "./session-hooks";
import { getPaymentProvider, type PaymentProvider, type ProviderPayment } from "./provider";
import { applyRefundOutcome, createRefundTx } from "./refunds";

// FR-06, PRD §6 payment sequence. Every confirmation path (Checkout callback, webhook,
// reconciliation) converges on settleTx, which runs under a row lock on the booking.

type Tx = Prisma.TransactionClient;
const MIN = 60_000;
const TX = { maxWait: 15_000, timeout: 20_000 };
export const RECONCILE_JOB = "payments.reconcile";
/** Statuses of a Payment whose order may still be paid (a failed attempt can be retried). */
const OPEN = ["ORDER_CREATED", "PENDING", "FAILED"] as const;

export type CapturedPayment = {
  providerPaymentId: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
};
export type SettleSource = "callback" | "webhook" | "reconcile";
export type SettleOutcome =
  | "confirmed"
  | "extension_applied"
  | "already_settled"
  | "refund_booking_failed"
  | "refund_duplicate_charge"
  | "refund_extension_unavailable"
  | "amount_mismatch"
  | "unknown_order";
export type SettleResult = {
  outcome: SettleOutcome;
  bookingId: string | null;
  /** Set when this call confirmed the booking: who to notify after commit. */
  confirmed?: { renterId: string; hostId: string };
  /** Set when this call settled an extension order (applied, or refunded as unavailable). */
  extension?: { quoteId: string; applied: boolean };
};

/** One daily reconcile per UTC day bucket; the job re-schedules the next one. */
export function scheduleReconcile(at: Date) {
  const day = Math.floor(at.getTime() / (24 * 60 * MIN)) + 1;
  return enqueue(
    RECONCILE_JOB,
    {},
    { runAt: new Date(day * 24 * 60 * MIN), idempotencyKey: `${RECONCILE_JOB}:${day}` },
  );
}

function audit(
  tx: Tx,
  action: string,
  targetId: string,
  metadata: Prisma.InputJsonObject,
  reason?: string,
) {
  return tx.auditLog.create({
    data: {
      actorId: null,
      action,
      targetType: "Payment",
      targetId,
      reason,
      metadata: { actor: "system", ...metadata },
    },
  });
}

/**
 * POST /api/payments/order. The amount is the hold's server-side snapshot, never client
 * input. An open order for the booking is reused, so retries and double clicks don't
 * create duplicates. Returns null when Razorpay isn't configured (route → 503).
 */
export async function createPaymentOrder(
  user: CurrentUser,
  bookingId: string,
): Promise<CreatePaymentOrderResponse | null> {
  const provider = getPaymentProvider();
  if (!provider) return null;
  const order = await db.$transaction(async (tx) => {
    // The lock serialises concurrent order requests for one booking.
    const [b] = await tx.$queryRaw<
      {
        renterId: string;
        status: string;
        totalPaise: number;
        currency: string;
        holdValid: boolean;
      }[]
    >`SELECT "renterId", status::text, "totalPaise", currency, ("holdExpiresAt" > now()) AS "holdValid"
      FROM "Booking" WHERE id = ${bookingId}::uuid FOR UPDATE`;
    if (!b || b.renterId !== user.id) throw new HttpError("not_found", "Booking not found");
    if (b.status !== "PENDING_PAYMENT" || !b.holdValid)
      throw new HttpError("conflict", "This booking is no longer awaiting payment", {
        reason: "hold_expired",
      });
    const open = await tx.payment.findFirst({
      where: {
        bookingId,
        status: { in: [...OPEN] },
        amountPaise: b.totalPaise,
        currency: b.currency,
      },
      orderBy: { createdAt: "desc" },
    });
    if (open)
      return { orderId: open.providerOrderId, amountPaise: b.totalPaise, currency: b.currency };
    const o = await provider.createOrder({
      amountPaise: b.totalPaise,
      currency: b.currency,
      receipt: bookingId,
      notes: { bookingId },
    });
    if (o.amount !== b.totalPaise || o.currency !== b.currency)
      throw new Error("provider order amount mismatch");
    await tx.payment.create({
      data: { bookingId, providerOrderId: o.id, amountPaise: b.totalPaise, currency: b.currency },
    });
    return { orderId: o.id, amountPaise: b.totalPaise, currency: b.currency };
  }, TX);
  await scheduleReconcile(new Date());
  return {
    bookingId,
    provider: "razorpay",
    orderId: order.orderId,
    keyId: provider.keyId,
    amount: { paise: order.amountPaise, currency: order.currency as "INR" },
    prefill: { name: user.name ?? undefined, email: user.email ?? undefined },
  };
}

/**
 * Sessions (T4.2): an order for an extension's extra time. The amount is the extension
 * quote's server-side snapshot; the quote must still start at the booking's current end.
 * An open order for the same quote is reused. Returns null when Razorpay isn't configured.
 */
export async function createExtensionOrder(
  user: CurrentUser,
  bookingId: string,
  quoteId: string,
): Promise<CreatePaymentOrderResponse | null> {
  const provider = getPaymentProvider();
  if (!provider) return null;
  const order = await db.$transaction(async (tx) => {
    const [b] = await tx.$queryRaw<{ renterId: string; status: string; endAt: Date }[]>`
      SELECT "renterId", status::text, "endAt" FROM "Booking" WHERE id = ${bookingId}::uuid FOR UPDATE`;
    if (!b || b.renterId !== user.id) throw new HttpError("not_found", "Booking not found");
    const quote = await tx.priceQuote.findUnique({ where: { id: quoteId } });
    if (
      !quote ||
      quote.renterId !== user.id ||
      !["CONFIRMED", "ACTIVE", "GRACE_PERIOD"].includes(b.status) ||
      quote.startAt.getTime() !== b.endAt.getTime()
    )
      throw new HttpError("conflict", "This extension can no longer be paid for", {
        reason: "extension_stale",
      });
    const open = await tx.payment.findFirst({
      where: { bookingId, extensionQuoteId: quoteId, status: { in: [...OPEN] } },
      orderBy: { createdAt: "desc" },
    });
    if (open) return { orderId: open.providerOrderId, amountPaise: open.amountPaise };
    const o = await provider.createOrder({
      amountPaise: quote.totalPaise,
      currency: quote.currency,
      receipt: bookingId,
      notes: { bookingId, extensionQuoteId: quoteId },
    });
    if (o.amount !== quote.totalPaise || o.currency !== quote.currency)
      throw new Error("provider order amount mismatch");
    await tx.payment.create({
      data: {
        bookingId,
        providerOrderId: o.id,
        amountPaise: quote.totalPaise,
        currency: quote.currency,
        extensionQuoteId: quoteId,
      },
    });
    return { orderId: o.id, amountPaise: quote.totalPaise };
  }, TX);
  await scheduleReconcile(new Date());
  return {
    bookingId,
    provider: "razorpay",
    orderId: order.orderId,
    keyId: provider.keyId,
    amount: { paise: order.amountPaise, currency: "INR" },
    prefill: { name: user.name ?? undefined, email: user.email ?? undefined },
  };
}

/**
 * The single settlement function. `p` must already be verified as captured (signed
 * webhook, or signature + provider fetch). Idempotent: re-settling the same payment is a
 * no-op, so duplicate webhooks and a racing callback are harmless (FR-06 AC3).
 */
export async function settleTx(
  tx: Tx,
  p: CapturedPayment,
  source: SettleSource,
): Promise<SettleResult> {
  const anchor = await tx.payment.findFirst({
    where: { providerOrderId: p.providerOrderId },
    orderBy: { createdAt: "asc" },
    select: { bookingId: true },
  });
  if (!anchor) {
    log("warn", "payment.unknown_order", { providerOrderId: p.providerOrderId, source });
    return { outcome: "unknown_order", bookingId: null };
  }
  const bookingId = anchor.bookingId;
  const [booking] = await tx.$queryRaw<
    {
      status: string;
      holdValid: boolean;
      totalPaise: number;
      hostEarningsPaise: number;
      currency: string;
      renterId: string;
      rentalType: string;
    }[]
  >`SELECT status::text, ("holdExpiresAt" > now()) AS "holdValid", "totalPaise", "hostEarningsPaise",
           currency, "renterId", "rentalType"::text AS "rentalType"
    FROM "Booking" WHERE id = ${bookingId}::uuid FOR UPDATE`;

  const rows = await tx.payment.findMany({
    where: { providerOrderId: p.providerOrderId },
    orderBy: { createdAt: "asc" },
  });
  const same = rows.find((r) => r.providerPaymentId === p.providerPaymentId);
  if (same && (same.status === "SUCCEEDED" || same.status === "CAPTURED_UNFULFILLED"))
    return { outcome: "already_settled", bookingId };

  const order = rows[0];
  if (p.amountPaise !== order.amountPaise || p.currency !== order.currency) {
    await audit(tx, "payment.amount_mismatch", order.id, { ...p, source }, "amount_mismatch");
    log("error", "payment.amount_mismatch", { ...p, expectedPaise: order.amountPaise, source });
    return { outcome: "amount_mismatch", bookingId };
  }

  // A retried attempt on the same order carries a new payment id: it overwrites the open
  // row. A second capture on an already-captured order gets its own row (then refunded).
  const row =
    same ??
    rows.find((r) => r.status !== "SUCCEEDED" && r.status !== "CAPTURED_UNFULFILLED") ??
    (await tx.payment.create({
      data: {
        bookingId,
        providerOrderId: p.providerOrderId,
        amountPaise: order.amountPaise,
        currency: order.currency,
        extensionQuoteId: order.extensionQuoteId,
      },
    }));

  const captured = {
    providerPaymentId: p.providerPaymentId,
    failureReason: null,
    ...(source === "callback" ? { signatureVerifiedAt: new Date() } : {}),
  };
  // Extension orders (T4.2) settle against their own quote: a booking capture and an
  // extension capture never count as each other's duplicate.
  const ext = order.extensionQuoteId;
  const priorCapture = await tx.payment.findFirst({
    where: { bookingId, status: "SUCCEEDED", id: { not: row.id }, extensionQuoteId: ext },
  });

  let confirmed = false;
  if (!priorCapture) {
    if (ext) {
      if (!sessionHooks.applyExtension) throw new Error("extension applier not registered");
      confirmed = await sessionHooks.applyExtension(tx, bookingId, ext);
    } else if (booking.status === "PENDING_PAYMENT" && booking.holdValid) {
      await confirmHeldBooking(tx, bookingId);
      confirmed = true;
    } else {
      // Late payment (FR-06 AC4): the slot is re-claimed if nobody took it. CANCELLED → refund.
      confirmed = await reclaimForPayment(tx, bookingId);
    }
  }

  if (confirmed) {
    await tx.payment.update({ where: { id: row.id }, data: { ...captured, status: "SUCCEEDED" } });
    // Append-only. GROSS = COMMISSION + HOST_EARNINGS by construction (any renter fee is platform's).
    // An extension books its quote's delta; applying it already bumped the booking's totals.
    const amounts = ext ? await tx.priceQuote.findUniqueOrThrow({ where: { id: ext } }) : booking;
    const ref = p.providerPaymentId;
    await tx.ledgerEntry.createMany({
      data: [
        {
          bookingId,
          account: "RENTER_PAYMENT" as const,
          amountPaise: amounts.totalPaise,
          reference: ref,
          memo: "gross",
        },
        {
          bookingId,
          account: "PLATFORM_COMMISSION" as const,
          amountPaise: amounts.totalPaise - amounts.hostEarningsPaise,
          reference: ref,
          memo: "commission",
        },
        {
          bookingId,
          account: "HOST_EARNINGS" as const,
          amountPaise: amounts.hostEarningsPaise,
          reference: ref,
          memo: "host_payable",
        },
      ].map(
        (e) => ({ ...e, currency: booking.currency }) satisfies Prisma.LedgerEntryCreateManyInput,
      ),
    });
    await audit(tx, "payment.captured", row.id, {
      ...p,
      bookingId,
      source,
      ...(ext && { extensionQuoteId: ext }),
    });
    if (ext)
      return {
        outcome: "extension_applied",
        bookingId,
        extension: { quoteId: ext, applied: true },
      };
    // Both the held and the re-claimed paths (T4.3).
    if (booking.rentalType === "MONTHLY") await onMonthlyConfirmed(tx, bookingId);
    const { hostId } = await tx.listing.findFirstOrThrow({
      where: { bookings: { some: { id: bookingId } } },
      select: { hostId: true },
    });
    return { outcome: "confirmed", bookingId, confirmed: { renterId: booking.renterId, hostId } };
  }

  // Money captured but nothing to fulfil: refund in full (FR-10).
  const reason = priorCapture
    ? "duplicate_charge"
    : ext
      ? "extension_unavailable"
      : "booking_failed_after_payment";
  if (booking.status === "PENDING_PAYMENT")
    await transition(tx, bookingId, "PAYMENT_FAILED", null, reason);
  await tx.payment.update({
    where: { id: row.id },
    data: { ...captured, status: "CAPTURED_UNFULFILLED", failureReason: reason },
  });
  await tx.ledgerEntry.create({
    data: {
      bookingId,
      account: "RENTER_PAYMENT",
      amountPaise: p.amountPaise,
      currency: p.currency,
      reference: p.providerPaymentId,
      memo: reason,
    },
  });
  await audit(tx, "payment.captured_unfulfilled", row.id, { ...p, bookingId, source }, reason);
  await createRefundTx(tx, {
    paymentId: row.id,
    amountPaise: p.amountPaise,
    reason,
    actorId: null,
    idempotencyKey: `auto:${reason}:${row.id}`,
  });
  log("warn", "payment.auto_refund", {
    bookingId,
    providerPaymentId: p.providerPaymentId,
    reason,
    source,
  });
  if (ext && !priorCapture)
    return {
      outcome: "refund_extension_unavailable",
      bookingId,
      extension: { quoteId: ext, applied: false },
    };
  return { outcome: priorCapture ? "refund_duplicate_charge" : "refund_booking_failed", bookingId };
}

/** After commit: BOOKING_CONFIRMED to renter and host, with deterministic keys. */
async function afterSettle(r: SettleResult) {
  if (r.extension && r.bookingId)
    await sessionHooks.extensionSettled?.(r.bookingId, r.extension.quoteId, r.extension.applied);
  if (!r.confirmed || !r.bookingId) return;
  await sessionHooks.confirmed?.(r.bookingId);
  const b = await db.booking.findUniqueOrThrow({
    where: { id: r.bookingId },
    select: { startAt: true, endAt: true, listing: { select: { title: true } } },
  });
  const payload = {
    bookingId: r.bookingId,
    listingTitle: b.listing.title,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
  };
  await notify(r.confirmed.renterId, "BOOKING_CONFIRMED_RENTER", payload, {
    idempotencyKey: `booking:${r.bookingId}:confirmed:renter`,
  });
  await notify(r.confirmed.hostId, "BOOKING_CONFIRMED_HOST", payload, {
    idempotencyKey: `booking:${r.bookingId}:confirmed:host`,
  });
}

export async function settlePayment(p: CapturedPayment, source: SettleSource) {
  const r = await db.$transaction((tx) => settleTx(tx, p, source), TX);
  await afterSettle(r);
  return r;
}

/** payment.failed: the order's open row goes FAILED; the booking stays held so the renter can retry. */
function markFailedTx(tx: Tx, providerOrderId: string, reason: string | null | undefined) {
  return tx.payment.updateMany({
    where: { providerOrderId, status: { in: ["ORDER_CREATED", "PENDING"] } },
    data: { status: "FAILED", failureReason: (reason ?? "payment_failed").slice(0, 500) },
  });
}

/** Captures an authorized payment (account auto-capture normally does this first). */
async function ensureCaptured(provider: PaymentProvider, p: ProviderPayment) {
  return p.status === "authorized" ? provider.capturePayment(p.id, p.amount, p.currency) : p;
}

const toCaptured = (p: ProviderPayment): CapturedPayment => ({
  providerPaymentId: p.id,
  providerOrderId: p.orderId,
  amountPaise: p.amount,
  currency: p.currency,
});

/**
 * POST /api/bookings/:id/confirm-payment. The Checkout callback alone never confirms
 * (FR-06 AC1): the signature must verify AND the provider must report the payment captured.
 * Returns false while the payment is still pending at the provider.
 */
export async function confirmFromCallback(
  provider: PaymentProvider,
  user: CurrentUser,
  bookingId: string,
  b: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string },
) {
  if (
    !provider.verifyPaymentSignature(b.razorpayOrderId, b.razorpayPaymentId, b.razorpaySignature)
  ) {
    log("warn", "payment.bad_signature", { bookingId, userId: user.id });
    throw new HttpError("validation_error", "Invalid payment signature", {
      reason: "invalid_signature",
    });
  }
  // A valid signature proves Razorpay issued it, not that the order is this caller's booking.
  const own = await db.payment.findFirst({
    where: { providerOrderId: b.razorpayOrderId, bookingId, booking: { renterId: user.id } },
  });
  if (!own) throw new HttpError("not_found", "Payment not found");

  const fetched = await provider.fetchPayment(b.razorpayPaymentId);
  if (
    fetched.orderId !== b.razorpayOrderId ||
    fetched.amount !== own.amountPaise ||
    fetched.currency !== own.currency
  )
    throw new HttpError("unprocessable", "Payment does not match this order", {
      reason: "payment_mismatch",
    });
  const p = await ensureCaptured(provider, fetched);
  if (p.status === "failed") {
    await db.$transaction((tx) => markFailedTx(tx, p.orderId, p.errorDescription));
    throw new HttpError("unprocessable", "The payment failed", { reason: "payment_failed" });
  }
  if (p.status !== "captured") return false;
  const r = await settlePayment(toCaptured(p), "callback");
  if (r.outcome === "amount_mismatch")
    throw new HttpError("unprocessable", "Payment amount does not match", {
      reason: "payment_mismatch",
    });
  return true;
}

const PaymentEntity = z.object({
  id: z.string(),
  order_id: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.string(),
  error_description: z.string().nullish(),
});
const RefundEntity = z.object({
  id: z.string(),
  payment_id: z.string(),
  receipt: z.string().nullish(),
  error_description: z.string().nullish(),
});
const entity = <T extends z.ZodType>(schema: T, payload: Record<string, unknown>, key: string) =>
  schema.safeParse((payload[key] as { entity?: unknown } | undefined)?.entity);

/**
 * A signature-verified webhook. The ProviderEvent insert and every effect share one
 * transaction, so an event is processed exactly once. Unknown events are stored and ignored.
 * Returns false for a duplicate delivery.
 */
export async function processWebhookEvent(eventId: string, event: RazorpayWebhookBody) {
  let settled: SettleResult | null = null;
  const fresh = await db.$transaction(async (tx) => {
    // ON CONFLICT, not catch-P2002: a failed statement would abort the whole transaction.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "ProviderEvent" (provider, "eventId", type, payload, "processedAt", "updatedAt")
      VALUES ('razorpay', ${eventId}, ${event.event}, ${JSON.stringify(event)}::jsonb, now(), now())
      ON CONFLICT (provider, "eventId") DO NOTHING RETURNING id`;
    if (inserted.length === 0) return false;

    switch (event.event) {
      case "payment.captured":
      case "order.paid": {
        const pay = entity(PaymentEntity, event.payload, "payment");
        if (!pay.success || pay.data.status !== "captured") break;
        settled = await settleTx(
          tx,
          {
            providerPaymentId: pay.data.id,
            providerOrderId: pay.data.order_id,
            amountPaise: pay.data.amount,
            currency: pay.data.currency,
          },
          "webhook",
        );
        break;
      }
      case "payment.failed": {
        const pay = entity(PaymentEntity, event.payload, "payment");
        if (pay.success) await markFailedTx(tx, pay.data.order_id, pay.data.error_description);
        break;
      }
      case "refund.processed":
      case "refund.failed": {
        const rf = entity(RefundEntity, event.payload, "refund");
        if (!rf.success) break;
        const ours = await tx.refund.findFirst({
          where: {
            OR: [
              { providerRefundId: rf.data.id },
              ...(z.uuid().safeParse(rf.data.receipt).success ? [{ id: rf.data.receipt! }] : []),
            ],
          },
        });
        if (!ours) {
          log("warn", "refund.unknown", { providerRefundId: rf.data.id });
          break;
        }
        await applyRefundOutcome(
          tx,
          ours.id,
          event.event === "refund.processed" ? "processed" : "failed",
          rf.data.id,
          rf.data.error_description,
        );
        break;
      }
    }
    return true;
  }, TX);
  if (settled) await afterSettle(settled);
  log("info", "webhook.processed", { eventId, event: event.event, duplicate: !fresh });
  return fresh;
}

/**
 * Daily reconciliation (also callable from the admin UI, T4.6). For orders still open
 * after 30 minutes, asks the provider what happened: a captured payment is settled (its
 * webhook was lost), an order with no live attempt whose hold has lapsed is closed FAILED.
 * Every discrepancy is logged and audited.
 */
export async function reconcilePayments(provider = getPaymentProvider(), olderThanMinutes = 30) {
  const summary = { checked: 0, settled: 0, failed: 0, discrepancies: 0 };
  if (!provider) return summary;
  const stale = await db.payment.findMany({
    where: {
      status: { in: [...OPEN] },
      reconciledAt: null,
      createdAt: { lt: new Date(Date.now() - olderThanMinutes * MIN) },
    },
    include: { booking: { select: { status: true, holdExpiresAt: true } } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  for (const row of stale) {
    summary.checked++;
    try {
      const attempts = await provider.fetchOrderPayments(row.providerOrderId);
      const live = attempts.find((a) => a.status === "captured" || a.status === "authorized");
      if (live) {
        const r = await settlePayment(
          toCaptured(await ensureCaptured(provider, live)),
          "reconcile",
        );
        summary.settled++;
        summary.discrepancies++;
        log("warn", "reconcile.discrepancy", {
          paymentId: row.id,
          kind: "captured_unsettled",
          outcome: r.outcome,
        });
        await db.auditLog.create({
          data: {
            action: "payment.reconciled",
            targetType: "Payment",
            targetId: row.id,
            reason: "captured_unsettled",
            metadata: { actor: "system", outcome: r.outcome, providerPaymentId: live.id },
          },
        });
        continue;
      }
      const holdOver =
        row.booking.status !== "PENDING_PAYMENT" ||
        (row.booking.holdExpiresAt ?? new Date(0)) < new Date();
      if (!holdOver) continue; // the renter may still pay; look again next run
      await db.$transaction(async (tx) => {
        await markFailedTx(tx, row.providerOrderId, row.failureReason ?? "reconciled_unpaid");
        await tx.payment.update({ where: { id: row.id }, data: { reconciledAt: new Date() } });
      });
      summary.failed++;
    } catch (e) {
      log("error", "reconcile.error", { paymentId: row.id, error: (e as Error).message });
    }
  }
  log("info", "reconcile.done", summary);
  return summary;
}
