import { cancelScheduled, notify, type NotificationPayload } from "@/server/notifications";

// Callers run these after commit; keys are deterministic, so a retry can't double-send.

export async function sendCancellationUpdate(
  userIds: string[],
  payload: NotificationPayload<"CANCELLATION_UPDATE">,
) {
  for (const userId of new Set(userIds))
    await notify(userId, "CANCELLATION_UPDATE", payload, {
      idempotencyKey: `cancellation:${payload.bookingId}:${userId}`,
    });
}

/** Pending reminders are keyed `booking:<id>:…` (T2.6). */
export const cancelBookingReminders = (bookingId: string) =>
  cancelScheduled(`booking:${bookingId}:`);
