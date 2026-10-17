"use client";

import { useState } from "react";
import type { BookingDetail, CreatePaymentOrderResponse } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DEMO_SECRET } from "@/lib/demo-constants";
import { formatINR } from "@/lib/money";
import { postWithHeaders, reasonOf } from "./api-client";

export async function computeClientDemoSignature(
  orderId: string,
  paymentId: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(DEMO_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(`${orderId}|${paymentId}`));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function DemoPaymentPanel({
  bookingId,
  totalPaise,
  disabled = false,
  orderOverride,
  onSuccess,
  onFailure,
  onBusyChange,
}: {
  bookingId: string;
  totalPaise: number;
  disabled?: boolean;
  orderOverride?: CreatePaymentOrderResponse;
  onSuccess: (booking?: BookingDetail) => void;
  onFailure?: (error: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const setInternalBusy = (isBusy: boolean) => {
    setBusy(isBusy);
    onBusyChange?.(isBusy);
  };

  async function executePayment(simulateFailure: boolean) {
    setInternalBusy(true);
    setErrorMsg(null);

    try {
      let order = orderOverride;
      if (!order) {
        order = await postWithHeaders<CreatePaymentOrderResponse>(
          "/api/payments/order",
          { bookingId },
          { "Idempotency-Key": crypto.randomUUID() },
        );
      }

      const randomHex = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const paymentId = simulateFailure
        ? `pay_demo_failed_${order.orderId}_${randomHex}`
        : `pay_demo_${order.orderId}_${randomHex}`;

      const signature = await computeClientDemoSignature(order.orderId, paymentId);

      const confirmed = await postWithHeaders<BookingDetail>(
        `/api/bookings/${bookingId}/confirm-payment`,
        {
          razorpayOrderId: order.orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
        },
        { "Idempotency-Key": crypto.randomUUID() },
      );

      onSuccess(confirmed);
    } catch (e: unknown) {
      if (simulateFailure || reasonOf(e) === "payment_failed") {
        const msg = "Simulated payment failure: The payment failed. You haven't been charged.";
        setErrorMsg(msg);
        onFailure?.(msg);
      } else {
        const msg = e instanceof Error ? e.message : "Payment confirmation failed.";
        setErrorMsg(msg);
        onFailure?.(msg);
      }
    } finally {
      setInternalBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="space-y-1">
          <p className="font-semibold text-sm text-amber-900 dark:text-amber-200">
            Simulated payment (demo mode, no real money)
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Razorpay keys are not configured. You can test settlement directly using the buttons below.
            Payments follow the exact same confirmation and settlement code paths.
          </p>
        </div>
      </div>

      {errorMsg ? (
        <Alert variant="destructive" className="py-2.5">
          <AlertTitle className="text-sm font-semibold">Payment update</AlertTitle>
          <AlertDescription className="text-xs">{errorMsg}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2.5 sm:flex-row">
        <Button
          type="button"
          className="h-11 flex-1 font-medium"
          disabled={disabled || busy}
          onClick={() => void executePayment(false)}
        >
          {busy ? "Processing payment…" : `Pay ${formatINR(totalPaise)}`}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 border-destructive/40 text-destructive hover:bg-destructive/10"
          disabled={disabled || busy}
          onClick={() => void executePayment(true)}
        >
          Simulate failure
        </Button>
      </div>
    </div>
  );
}
