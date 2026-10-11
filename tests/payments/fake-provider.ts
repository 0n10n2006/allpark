import { createHmac, randomUUID } from "node:crypto";
import {
  hmacMatches,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderRefund,
} from "@/server/payments/provider";

// In-memory Razorpay stand-in, injected by tests with setPaymentProvider(). Signatures are
// real HMAC-SHA256 with obviously fake test secrets, verified by the same hmacMatches as prod.

export const KEY_SECRET = "test_key_secret_not_real";
export const WEBHOOK_SECRET = "test_webhook_secret_not_real";

export const signPayment = (orderId: string, paymentId: string) =>
  createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
export const signWebhook = (raw: string) =>
  createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");

export class FakeProvider implements PaymentProvider {
  readonly keyId = "rzp_test_fake";
  orders = new Map<string, { amount: number; currency: string; receipt: string }>();
  payments = new Map<string, ProviderPayment>();
  refunds: { id: string; paymentId: string; amount: number; receipt: string }[] = [];
  refundCalls = 0;

  async createOrder(i: { amountPaise: number; currency: string; receipt: string }) {
    const id = `order_${randomUUID().slice(0, 12)}`;
    this.orders.set(id, { amount: i.amountPaise, currency: i.currency, receipt: i.receipt });
    return { id, amount: i.amountPaise, currency: i.currency };
  }

  /** Test helper: a payment attempt on an order (defaults: captured, full amount). */
  pay(orderId: string, over: Partial<ProviderPayment> = {}): ProviderPayment {
    const o = this.orders.get(orderId)!;
    const p: ProviderPayment = {
      id: `pay_${randomUUID().slice(0, 12)}`,
      orderId,
      status: "captured",
      amount: o.amount,
      currency: o.currency,
      ...over,
    };
    this.payments.set(p.id, p);
    return p;
  }

  async fetchPayment(id: string) {
    const p = this.payments.get(id);
    if (!p) throw new Error("not found");
    return { ...p };
  }

  async fetchOrderPayments(orderId: string) {
    return [...this.payments.values()].filter((p) => p.orderId === orderId).reverse();
  }

  async capturePayment(id: string) {
    const p = this.payments.get(id)!;
    p.status = "captured";
    return { ...p };
  }

  async refund(i: {
    paymentId: string;
    amountPaise: number;
    receipt: string;
  }): Promise<ProviderRefund> {
    this.refundCalls++;
    const prior = this.refunds.find((r) => r.receipt === i.receipt);
    if (prior) return { id: prior.id, status: "pending" };
    const r = {
      id: `rfnd_${randomUUID().slice(0, 12)}`,
      paymentId: i.paymentId,
      amount: i.amountPaise,
      receipt: i.receipt,
    };
    this.refunds.push(r);
    return { id: r.id, status: "pending" };
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return hmacMatches(KEY_SECRET, `${orderId}|${paymentId}`, signature);
  }

  verifyWebhookSignature(raw: string, signature: string) {
    return hmacMatches(WEBHOOK_SECRET, raw, signature);
  }
}
