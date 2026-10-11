import type { BookingStatus, Prisma } from "@/generated/prisma/client";
import { errorCode, HttpError } from "@/server/http/errors";

// PRD §5. The only legal booking status moves; everything else throws.
export const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  PENDING_PAYMENT: ["CONFIRMED", "EXPIRED", "PAYMENT_FAILED", "CANCELLED"],
  // CONFIRMED → GRACE_PERIOD: never checked in by endAt (no-show or unconfirmed; no penalty).
  CONFIRMED: ["ACTIVE", "GRACE_PERIOD", "CANCELLED", "DISPUTED"],
  ACTIVE: ["GRACE_PERIOD", "COMPLETED", "DISPUTED"],
  // GRACE_PERIOD → ACTIVE: only a paid extension moving endAt back into the future.
  GRACE_PERIOD: ["ACTIVE", "COMPLETED", "OVERSTAY", "DISPUTED"],
  OVERSTAY: ["COMPLETED", "DISPUTED"],
  DISPUTED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  PAYMENT_FAILED: [],
};

export const canTransition = (from: BookingStatus, to: BookingStatus) =>
  TRANSITIONS[from].includes(to);

type Tx = Prisma.TransactionClient;

function writeAudit(
  tx: Tx,
  bookingId: string,
  actorId: string | null,
  from: BookingStatus,
  to: BookingStatus,
  reason?: string | null,
) {
  return tx.auditLog.create({
    data: {
      actorId,
      action: "booking.transition",
      targetType: "Booking",
      targetId: bookingId,
      reason: reason ?? null,
      metadata: { from, to },
    },
  });
}

/**
 * Moves a booking from its current status to `to`. The UPDATE is conditional on the
 * status it read, so of two concurrent transitions from the same state exactly one wins;
 * the loser gets 409. `actorId` is null for system actions.
 */
export async function transition(
  tx: Tx,
  bookingId: string,
  to: BookingStatus,
  actorId: string | null,
  reason?: string | null,
) {
  const current = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { status: true },
  });
  if (!current) throw new HttpError("not_found", "Booking not found");
  const from = current.status;
  if (!canTransition(from, to))
    throw new HttpError("conflict", `Can't move a ${from} booking to ${to}`, {
      reason: "illegal_transition",
      from,
      to,
    });
  const cancelled =
    to === "CANCELLED" ? { cancelledAt: new Date(), cancellationReason: reason } : {};
  const { count } = await tx.booking.updateMany({
    where: { id: bookingId, status: from },
    data: { status: to, ...cancelled },
  });
  if (count === 0)
    throw new HttpError("conflict", "Booking status changed concurrently", {
      reason: "status_changed",
    });
  await writeAudit(tx, bookingId, actorId, from, to, reason);
  return tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
}

/**
 * Called by payments (T4.1) once a payment is verified. Flips the hold to CONFIRMED only
 * if it is still PENDING_PAYMENT and unexpired by database time; otherwise 409
 * `hold_expired`, and the caller runs the payment-success/booking-failure refund path.
 */
export async function confirmHeldBooking(tx: Tx, bookingId: string, actorId: string | null = null) {
  const count = await tx.$executeRaw`
    UPDATE "Booking" SET status = 'CONFIRMED', "updatedAt" = now()
    WHERE id = ${bookingId}::uuid AND status = 'PENDING_PAYMENT' AND "holdExpiresAt" > now()`;
  if (count === 0)
    throw new HttpError("conflict", "The hold has expired or is no longer pending", {
      reason: "hold_expired",
    });
  await writeAudit(tx, bookingId, actorId, "PENDING_PAYMENT", "CONFIRMED", "payment_verified");
  return tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
}

/**
 * Payments (T4.1): a payment landed after the hold lapsed. Re-claims the slot for a
 * PENDING_PAYMENT (expired) or EXPIRED booking by flipping it to CONFIRMED. The
 * booking_no_overlap constraint decides: 23P01 → false and the slot stays with whoever
 * took it (the caller refunds). Runs under a SAVEPOINT so the caller's transaction survives.
 */
export async function reclaimForPayment(tx: Tx, bookingId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ status: BookingStatus }[]>`
    SELECT status FROM "Booking" WHERE id = ${bookingId}::uuid`;
  if (!row || (row.status !== "PENDING_PAYMENT" && row.status !== "EXPIRED")) return false;
  // Racing inserts on booking_no_overlap can deadlock (40P01 / Prisma P2034) instead of
  // raising 23P01: retry from the savepoint, and if it persists treat the slot as taken
  // (the caller refunds; never a 500).
  for (let attempt = 1; ; attempt++) {
    await tx.$executeRaw`SAVEPOINT reclaim_for_payment`;
    try {
      const count = await tx.$executeRaw`
        UPDATE "Booking" SET status = 'CONFIRMED', "updatedAt" = now()
        WHERE id = ${bookingId}::uuid AND status IN ('PENDING_PAYMENT', 'EXPIRED')`;
      await tx.$executeRaw`RELEASE SAVEPOINT reclaim_for_payment`;
      if (count === 0) return false;
      break;
    } catch (e) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT reclaim_for_payment`;
      const code = errorCode(e);
      if (code === "23P01") return false;
      if (code === "40P01" || code === "P2034") {
        if (attempt >= 3) return false;
        continue;
      }
      throw e;
    }
  }
  await writeAudit(tx, bookingId, null, row.status, "CONFIRMED", "payment_reclaimed");
  return true;
}
