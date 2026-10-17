import { createHmac, randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { DEMO_KEY_ID, DEMO_SECRET } from "@/lib/demo-constants";
import {
  hmacMatches,
  type PaymentProvider,
  type ProviderOrder,
  type ProviderPayment,
  type ProviderRefund,
} from "./provider";

export { DEMO_KEY_ID, DEMO_SECRET };

export function computeDemoPaymentSignature(orderId: string, paymentId: string): string {
  return createHmac("sha256", DEMO_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
}

type OrderRecord = {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
};

export class DemoProvider implements PaymentProvider {
  readonly keyId = DEMO_KEY_ID;
  private orders = new Map<string, OrderRecord>();
  private refunds = new Map<string, ProviderRefund>();

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<ProviderOrder> {
    const id = `order_demo_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const order: OrderRecord = {
      id,
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    };
    this.orders.set(id, order);
    return { id, amount: input.amountPaise, currency: input.currency };
  }

  async fetchPayment(paymentId: string): Promise<ProviderPayment> {
    const isFailed = paymentId.includes("fail");

    // Try to extract orderId from paymentId format: pay_demo_[fail_]order_demo_<hash>...
    let orderId = "";
    const match = paymentId.match(/order_demo_[0-9a-f]+/i);
    if (match) {
      orderId = match[0];
    }

    let amount = 0;
    let currency = "INR";

    // 1. Check in-memory orders
    if (orderId && this.orders.has(orderId)) {
      const order = this.orders.get(orderId)!;
      amount = order.amount;
      currency = order.currency;
    } else {
      // 2. Query DB payment
      const p = await db.payment.findFirst({
        where: orderId ? { providerOrderId: orderId } : { providerPaymentId: paymentId },
        select: { providerOrderId: true, amountPaise: true, currency: true },
      });
      if (p) {
        orderId = p.providerOrderId;
        amount = p.amountPaise;
        currency = p.currency;
      }
    }

    if (isFailed) {
      return {
        id: paymentId,
        orderId,
        status: "failed",
        amount,
        currency,
        errorDescription: "Simulated payment failure (demo mode)",
      };
    }

    return {
      id: paymentId,
      orderId,
      status: "captured",
      amount,
      currency,
    };
  }

  async fetchOrderPayments(orderId: string): Promise<ProviderPayment[]> {
    const payment = await this.fetchPayment(`pay_demo_${orderId}`);
    return [payment];
  }

  async capturePayment(
    paymentId: string,
    amountPaise: number,
    currency: string,
  ): Promise<ProviderPayment> {
    const p = await this.fetchPayment(paymentId);
    return {
      ...p,
      status: "captured",
      amount: amountPaise,
      currency,
    };
  }

  async fetchRefund(paymentId: string, receipt: string): Promise<ProviderRefund | null> {
    return this.refunds.get(`${paymentId}:${receipt}`) ?? null;
  }

  async refund(input: {
    paymentId: string;
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<ProviderRefund> {
    const prior = await this.fetchRefund(input.paymentId, input.receipt);
    if (prior) return prior;

    const id = `rfnd_demo_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const r: ProviderRefund = { id, status: "processed" };
    this.refunds.set(`${input.paymentId}:${input.receipt}`, r);
    return r;
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    return hmacMatches(DEMO_SECRET, `${orderId}|${paymentId}`, signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return hmacMatches(DEMO_SECRET, rawBody, signature);
  }
}

let demoProviderSingleton: DemoProvider | null = null;

export function getDemoProvider(): DemoProvider {
  if (!demoProviderSingleton) {
    demoProviderSingleton = new DemoProvider();
  }
  return demoProviderSingleton;
}
