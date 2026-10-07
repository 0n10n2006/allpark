export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Used for logs and as the provider idempotency key; never logged with content. */
  notificationId: string;
  type: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Dev/test fallback: logs type + id only, never addresses or content (PRD §9). */
export class LogSender implements EmailSender {
  async send({ type, notificationId }: EmailMessage) {
    console.log(JSON.stringify({ event: "email.log", type, notificationId }));
  }
}

export class ResendSender implements EmailSender {
  constructor(
    private apiKey: string,
    private from: string,
  ) {}

  async send(m: EmailMessage) {
    const { Resend } = await import("resend");
    const { error } = await new Resend(this.apiKey).emails.send(
      { from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html },
      // A retry after a crash between send and marking SENT doesn't send twice.
      { idempotencyKey: `notification/${m.notificationId}` },
    );
    // Provider errors can echo the recipient; keep only the error name.
    if (error) throw new Error(`Resend send failed: ${error.name}`);
  }
}

let override: EmailSender | null = null;

/** Tests inject a sender; pass null to restore the env-based default. */
export function setEmailSender(sender: EmailSender | null) {
  override = sender;
}

// Read env at send time, not via @/lib/env: that parses the whole env on import,
// which every jobs import (worker, next build) would then pay for.
export function getEmailSender(): EmailSender {
  if (override) return override;
  const key = process.env.RESEND_API_KEY;
  return key ? new ResendSender(key, process.env.EMAIL_FROM ?? "") : new LogSender();
}
