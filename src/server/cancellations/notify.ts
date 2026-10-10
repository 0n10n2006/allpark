import { db } from "@/server/db";
import { log } from "@/server/payments/log";

// Adapter over T2.6's notify()/cancelScheduled() (same pattern as src/server/payments/notify.ts).
// TODO(T2.6 merge): replace both bodies with
//   import { notify, cancelScheduled } from "@/server/notifications";
// Callers run these after commit; keys are deterministic, so a retry can't double-send.

export type CancellationUpdate = {
  bookingId: string;
  listingTitle: string;
  startAt: string;
  endAt: string;
  cancelledBy: "RENTER" | "HOST" | "ADMIN" | "SYSTEM";
};

export async function sendCancellationUpdate(userIds: string[], payload: CancellationUpdate) {
  for (const userId of new Set(userIds))
    log("info", "notification.pending_t2_6", {
      userId,
      type: "CANCELLATION_UPDATE",
      ...payload,
      idempotencyKey: `cancellation:${payload.bookingId}:${userId}`,
    });
}

/** Pending reminders are keyed `booking:<id>:…` (T2.6); same body as its cancelScheduled. */
export async function cancelBookingReminders(bookingId: string) {
  const { count } = await db.notification.updateMany({
    where: { idempotencyKey: { startsWith: `booking:${bookingId}:` }, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  return count;
}
