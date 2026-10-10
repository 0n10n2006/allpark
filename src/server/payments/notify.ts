import { log } from "./log";

// Adapter over T2.6's planned notify(userId, type, payload, { idempotencyKey }).
// TODO(T2.6 merge): replace the body with
//   import { notify } from "@/server/notifications";
//   await notify(userId, type, payload, { idempotencyKey });
// Callers run this after commit; keys are deterministic, so a retry can't double-send.
export async function sendNotification(
  userId: string,
  type: "BOOKING_CONFIRMED_RENTER" | "BOOKING_CONFIRMED_HOST",
  payload: { bookingId: string },
  opts: { idempotencyKey: string },
) {
  log("info", "notification.pending_t2_6", { userId, type, ...payload, ...opts });
}
