import { createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";

// FR-06. The only module that talks to Razorpay. Tests inject a fake with
// setPaymentProvider(); app code never picks one by environment.

export type ProviderOrder = { id: string; amount: number; currency: string };
export type ProviderPayment = {
  id: string;
  orderId: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  amount: number;
  currency: string;
  errorDescription?: string | null;
};
export type ProviderRefund = { id: string; status: "pending" | "processed" | "failed" };

export interface PaymentProvider {
  readonly keyId: string;
  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<ProviderOrder>;
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
  /** Payments for an order, newest first (reconciliation). */
  fetchOrderPayments(orderId: string): Promise<ProviderPayment[]>;
  capturePayment(
    paymentId: string,
    amountPaise: number,
    currency: string,
  ): Promise<ProviderPayment>;
  /** `receipt` is our Refund id: an existing provider refund with that receipt is returned, not repeated. */
  refund(input: {
    paymentId: string;
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<ProviderRefund>;
  /** Read-only: the provider refund for our Refund id (`receipt`), or null if it never arrived. */
  fetchRefund(paymentId: string, receipt: string): Promise<ProviderRefund | null>;
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

/** Constant-time comparison of a hex HMAC-SHA256 against a claimed signature. */
export function hmacMatches(secret: string, payload: string, signature: string) {
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type RzPayment = {
  id: string;
  order_id: string;
  status: ProviderPayment["status"];
  amount: number | string;
  currency: string;
  error_description?: string | null;
};
const toPayment = (p: RzPayment): ProviderPayment => ({
  id: p.id,
  orderId: p.order_id,
  status: p.status,
  amount: Number(p.amount),
  currency: p.currency,
  errorDescription: p.error_description ?? null,
});

export class RazorpayProvider implements PaymentProvider {
  private rz: Razorpay;
  constructor(
    readonly keyId: string,
    private keySecret: string,
    private webhookSecret: string,
    hostUrl?: string,
  ) {
    this.rz = new Razorpay({ key_id: keyId, key_secret: keySecret });
    // e2e points the SDK's axios client at a local fake Razorpay API.
    if (hostUrl)
      (
        this.rz as unknown as { api: { rq: { defaults: { baseURL: string } } } }
      ).api.rq.defaults.baseURL = hostUrl;
  }

  async createOrder(i: Parameters<PaymentProvider["createOrder"]>[0]) {
    const o = await this.rz.orders.create({
      amount: i.amountPaise,
      currency: i.currency,
      receipt: i.receipt,
      notes: i.notes,
    });
    return { id: o.id, amount: Number(o.amount), currency: o.currency };
  }

  async fetchPayment(paymentId: string) {
    return toPayment((await this.rz.payments.fetch(paymentId)) as unknown as RzPayment);
  }

  async fetchOrderPayments(orderId: string) {
    const res = (await this.rz.orders.fetchPayments(orderId)) as unknown as { items: RzPayment[] };
    return res.items.map(toPayment);
  }

  async capturePayment(paymentId: string, amountPaise: number, currency: string) {
    return toPayment(
      (await this.rz.payments.capture(paymentId, amountPaise, currency)) as unknown as RzPayment,
    );
  }

  async fetchRefund(paymentId: string, receipt: string) {
    const r = (await this.rz.payments.fetchMultipleRefund(paymentId, { count: 100 })).items.find(
      (x) => x.receipt === receipt,
    );
    return r ? { id: r.id, status: r.status as ProviderRefund["status"] } : null;
  }

  async refund(i: Parameters<PaymentProvider["refund"]>[0]) {
    // A retry after a crash between this call and our DB write must not refund twice.
    const prior = await this.fetchRefund(i.paymentId, i.receipt);
    if (prior) return prior;
    const r = await this.rz.payments.refund(i.paymentId, {
      amount: i.amountPaise,
      receipt: i.receipt,
      notes: i.notes,
    });
    return { id: r.id, status: r.status as ProviderRefund["status"] };
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return hmacMatches(this.keySecret, `${orderId}|${paymentId}`, signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string) {
    return hmacMatches(this.webhookSecret, rawBody, signature);
  }
}

let injected: PaymentProvider | null = null;

/** Tests only: install a fake provider (pass null to restore the env-configured one). */
export function setPaymentProvider(p: PaymentProvider | null) {
  injected = p;
}

/** The configured provider, or null when RAZORPAY_* env is missing (→ 503 payments_not_configured). */
export function getPaymentProvider(): PaymentProvider | null {
  if (injected) return injected;
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RAZORPAY_API_URL } =
    process.env;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !RAZORPAY_WEBHOOK_SECRET) return null;
  return new RazorpayProvider(
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET,
    // e2e only (a fake Razorpay API under `next dev`); never honoured in production.
    process.env.NODE_ENV === "production" ? undefined : RAZORPAY_API_URL,
  );
}

export const notConfigured = () =>
  Response.json(
    { error: { code: "payments_not_configured", message: "Payments are not configured" } },
    { status: 503 },
  );
