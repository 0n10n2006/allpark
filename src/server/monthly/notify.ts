// Adapter over T2.6's planned notify(userId, type, payload, { idempotencyKey }).
// Callers run this after commit; keys are deterministic, so a retry can't double-send.
export async function sendMonthlyNotification(
  _userId: string,
  _type: "MONTHLY_RENEWAL_DUE" | "MONTHLY_EXPIRED" | "MONTHLY_NOTICE_GIVEN",
  _payload: Record<string, unknown>,
  _opts: { idempotencyKey: string },
) {
  // Local adapter matching src/server/payments/notify.ts
  void _userId;
  void _type;
  void _payload;
  void _opts;
}
