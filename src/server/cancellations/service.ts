import type { BookingDetail } from "@/contracts";
import { getActivePolicy, POLICY_DEFAULTS, type Policy } from "@/config/policy";
import type { BookingStatus, Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { getBooking } from "@/server/bookings/service";
import { transition } from "@/server/bookings/state";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { createRefundTx } from "@/server/payments/refunds";
import { cancelBookingReminders, sendCancellationUpdate } from "./notify";
import { computeCancellationRefund } from "./policy";

type Tx = Prisma.TransactionClient;

/** ACTIVE and later go through disputes; DISPUTED → CANCELLED is an admin decision. */
const CANCELLABLE: BookingStatus[] = ["PENDING_PAYMENT", "CONFIRMED"];

/** The latest captured payment and what is still refundable on it, or null if nothing was captured. */
export async function refundablePayment(tx: Tx, bookingId: string) {
  const payment = await tx.payment.findFirst({
    where: { bookingId, status: { in: ["SUCCEEDED", "CAPTURED_UNFULFILLED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!payment) return null;
  const { _sum } = await tx.refund.aggregate({
    where: { paymentId: payment.id, status: { not: "FAILED" } },
    _sum: { amountPaise: true },
  });
  // ponytail: refunds only the latest capture; spread across payments if extensions get their own.
  return { payment, refundablePaise: payment.amountPaise - (_sum.amountPaise ?? 0) };
}

/** The booking's SUCCEEDED payments (original + paid extensions), oldest first, each with what is still refundable on it. */
async function refundablePayments(tx: Tx, bookingId: string) {
  const payments = await tx.payment.findMany({
    where: { bookingId, status: "SUCCEEDED" },
    include: { refunds: { where: { status: { not: "FAILED" } }, select: { amountPaise: true } } },
    orderBy: { createdAt: "asc" },
  });
  return payments.map((p) => ({
    id: p.id,
    amountPaise: p.amountPaise,
    refundablePaise: p.amountPaise - p.refunds.reduce((s, r) => s + r.amountPaise, 0),
  }));
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * POST /api/bookings/:id/cancel (FR-10). Renter: refund by the policy tier the booking was
 * quoted under. Host: full refund plus a host-cancellation audit record. The booking moves to
 * CANCELLED and the refund is created PENDING in the same transaction; the refund then runs
 * its own state machine. Already CANCELLED → the booking as it is, no second refund.
 */
export async function cancelBooking(
  id: string,
  user: CurrentUser,
  reason?: string,
): Promise<BookingDetail> {
  const b = await db.booking.findUnique({
    where: { id },
    include: {
      listing: { select: { hostId: true, title: true, cancellationPolicy: true } },
      quote: { select: { policyVersion: { select: { policy: true } } } },
    },
  });
  const isRenter = b?.renterId === user.id;
  const isHost = b?.listing.hostId === user.id;
  if (!b || !(isRenter || isHost)) throw new HttpError("not_found", "Booking not found");
  if (b.status === "CANCELLED") return getBooking(id, user);
  if (!CANCELLABLE.includes(b.status))
    throw new HttpError(
      "conflict",
      `A ${b.status} booking can't be cancelled; report a problem instead`,
      {
        reason: "not_cancellable",
        status: b.status,
      },
    );

  // Terms as agreed: the quote's policy snapshot (rows without a quote use the active one).
  const policy: Policy = b.quote
    ? { ...POLICY_DEFAULTS, ...(b.quote.policyVersion.policy as Partial<Policy>) }
    : await getActivePolicy();
  // A host renting their own space cancels as a renter (no free full refund).
  const kind = isRenter ? "renter_cancellation" : "host_cancellation";

  await db.$transaction(async (tx) => {
    await transition(tx, id, "CANCELLED", user.id, reason || kind);
    // A hold (PENDING_PAYMENT) has nothing captured to refund.
    const paid = b.status === "PENDING_PAYMENT" ? [] : await refundablePayments(tx, id);
    const refundable = sum(paid.map((p) => p.refundablePaise));
    const amountPaise = isRenter
      ? Math.min(
          refundable,
          computeCancellationRefund({
            policy,
            policyKey: b.listing.cancellationPolicy,
            rentalType: b.rentalType,
            startAt: b.startAt,
            now: new Date(),
            paidPaise: sum(paid.map((p) => p.amountPaise)),
          }).refundPaise,
        )
      : refundable;
    // One refund per payment (each capture refunds against itself), capped at what it has left.
    let left = amountPaise;
    for (const p of paid) {
      const part = Math.min(left, p.refundablePaise);
      if (part <= 0) continue;
      await createRefundTx(tx, {
        paymentId: p.id,
        amountPaise: part,
        reason: kind,
        actorId: user.id,
        idempotencyKey: `cancellation:${id}:${p.id}`,
      });
      left -= part;
    }
    if (kind === "host_cancellation")
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "booking.host_cancellation",
          targetType: "Booking",
          targetId: id,
          reason: reason || kind,
          metadata: { listingId: b.listingId, refundPaise: amountPaise },
        },
      });
  });

  await cancelBookingReminders(id);
  await sendCancellationUpdate([b.renterId, b.listing.hostId], {
    bookingId: id,
    listingTitle: b.listing.title,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    cancelledBy: isRenter ? "RENTER" : "HOST",
  });
  return getBooking(id, user);
}
