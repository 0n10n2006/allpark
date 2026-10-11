"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { useRouter } from "next/navigation";
import type { BookingDetail, CreatePaymentOrderResponse } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";
import { formatINR } from "@/lib/money";
import { postWithHeaders, reasonOf } from "./api-client";

// FR-06. Order → Razorpay Checkout → confirm-payment → poll until the server says
// CONFIRMED. The browser never decides the outcome: "confirmed" only comes from the API.

type RazorpayResponse = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};
type RazorpayInstance = {
  open(): void;
  on(event: "payment.failed", cb: (r: { error?: { description?: string } }) => void): void;
};
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

type State =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "confirming" }
  | { kind: "retry"; message: string }
  | { kind: "not_configured" }
  | { kind: "unfulfilled" }
  | { kind: "slow" };

/**
 * Captured but not fulfilled (slot gone, auto-refund). EXPIRED alone isn't final: a late
 * payment can still re-claim the slot.
 */
const failedForGood = (b: BookingDetail) =>
  b.status === "PAYMENT_FAILED" || b.paymentStatus === "CAPTURED_UNFULFILLED";

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 60_000;

export function PaySection({
  bookingId,
  totalPaise,
  configured,
  canPay,
  onBusyChange,
}: {
  bookingId: string;
  totalPaise: number;
  /** Server-side: are RAZORPAY_* keys set? */
  configured: boolean;
  /** The hold is live by server time. */
  canPay: boolean;
  /** True while a payment is being confirmed. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<State>(
    configured ? { kind: "idle" } : { kind: "not_configured" },
  );
  const polling = useRef(false);
  const busy = state.kind === "confirming" || state.kind === "slow";
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  /** Polls the booking until the server settles it (the webhook may land first). */
  async function awaitConfirmation() {
    if (polling.current) return;
    polling.current = true;
    const until = Date.now() + POLL_LIMIT_MS;
    try {
      while (Date.now() < until) {
        const b = await api<BookingDetail>(`/api/bookings/${bookingId}`).catch(() => null);
        if (b?.status === "CONFIRMED") return router.refresh();
        if (b && failedForGood(b)) return setState({ kind: "unfulfilled" });
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      setState({ kind: "slow" });
    } finally {
      polling.current = false;
    }
  }

  async function onPaid(r: RazorpayResponse) {
    setState({ kind: "confirming" });
    try {
      const b = await postWithHeaders<BookingDetail>(
        `/api/bookings/${bookingId}/confirm-payment`,
        {
          razorpayOrderId: r.razorpay_order_id,
          razorpayPaymentId: r.razorpay_payment_id,
          razorpaySignature: r.razorpay_signature,
        },
        { "Idempotency-Key": crypto.randomUUID() },
      );
      if (b.status === "CONFIRMED") return router.refresh();
      if (failedForGood(b)) return setState({ kind: "unfulfilled" });
    } catch (e) {
      if (reasonOf(e) === "payment_failed")
        return setState({
          kind: "retry",
          message: "The payment didn't go through. You haven't been charged.",
        });
      // Anything else: the webhook may still settle it, so keep waiting on the server.
    }
    await awaitConfirmation();
  }

  async function pay() {
    if (!window.Razorpay) return;
    setState({ kind: "opening" });
    let order: CreatePaymentOrderResponse;
    try {
      order = await postWithHeaders<CreatePaymentOrderResponse>(
        "/api/payments/order",
        { bookingId },
        { "Idempotency-Key": crypto.randomUUID() },
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) return setState({ kind: "not_configured" });
      if (reasonOf(e) === "hold_expired") return router.refresh();
      return setState({
        kind: "retry",
        message: "We couldn't start the payment. Please try again.",
      });
    }
    const rzp = new window.Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount.paise,
      currency: order.amount.currency,
      name: "ParkShare",
      description: "Parking booking",
      prefill: order.prefill,
      handler: (r: RazorpayResponse) => void onPaid(r),
      modal: {
        ondismiss: () =>
          setState((s) =>
            s.kind === "opening"
              ? {
                  kind: "retry",
                  message: "Payment was cancelled. You can try again while your hold lasts.",
                }
              : s,
          ),
      },
    });
    rzp.on("payment.failed", (r) =>
      setState({
        kind: "retry",
        message: `The payment failed${r.error?.description ? `: ${r.error.description}` : ""}. You can try again.`,
      }),
    );
    rzp.open();
  }

  if (state.kind === "not_configured")
    return (
      <Alert role="alert">
        <AlertTitle>Payments not configured</AlertTitle>
        <AlertDescription>
          Online payment isn&apos;t available right now. Your hold isn&apos;t charged.
        </AlertDescription>
      </Alert>
    );
  if (state.kind === "confirming")
    return (
      <p role="status" aria-live="polite" className="font-medium">
        Confirming your payment…
      </p>
    );
  if (state.kind === "unfulfilled")
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>We couldn&apos;t complete this booking</AlertTitle>
        <AlertDescription>
          Your payment was received but the space was no longer available. A full refund has been
          started.{" "}
          <Link href="/bookings" className="underline underline-offset-4">
            See your bookings
          </Link>
        </AlertDescription>
      </Alert>
    );
  if (state.kind === "slow")
    return (
      <Alert role="status">
        <AlertTitle>Still confirming your payment</AlertTitle>
        <AlertDescription>
          This is taking longer than usual. We&apos;ll notify you as soon as it&apos;s confirmed.{" "}
          <Link href="/bookings" className="underline underline-offset-4">
            See your bookings
          </Link>
        </AlertDescription>
      </Alert>
    );

  return (
    <div className="space-y-3">
      {canPay ? (
        <Script src="https://checkout.razorpay.com/v1/checkout.js" onReady={() => setReady(true)} />
      ) : null}
      {state.kind === "retry" ? (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      ) : null}
      <Button
        className="h-11 w-full"
        disabled={!canPay || !ready || state.kind === "opening"}
        onClick={() => void pay()}
      >
        {state.kind === "opening" ? "Waiting for payment…" : `Pay ${formatINR(totalPaise)}`}
      </Button>
    </div>
  );
}
