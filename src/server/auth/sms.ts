/**
 * SMS delivery for phone one-time codes (FR-01, plan decision Q4). No SMS provider is chosen
 * yet: India needs DLT-registered sender IDs and templates (MSG91, Twilio, ...). A real provider
 * implements `SmsSender` and is returned from `getSmsSender()`; until then phone sign-in is
 * available in development and test only, and production answers 503 instead of pretending.
 */
export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

/** Dev/test: the code goes to the server console only, never the structured logger or the DB. */
export const consoleSmsSender: SmsSender = {
  async send(to, text) {
    console.log(`\n[auth] SMS to ${to} (dev only): ${text}\n`);
  },
};

let override: SmsSender | null | undefined;

/** Tests swap the sender to capture codes; pass `undefined` to restore the default. */
export function setSmsSenderForTests(sender: SmsSender | null | undefined) {
  override = sender;
}

export function getSmsSender(): SmsSender | null {
  if (override !== undefined) return override;
  return process.env.NODE_ENV === "production" ? null : consoleSmsSender;
}

export const phoneAuthEnabled = () => getSmsSender() !== null;

export const smsNotConfigured = () =>
  Response.json(
    { error: { code: "sms_not_configured", message: "Phone sign-in is not available yet" } },
    { status: 503 },
  );
