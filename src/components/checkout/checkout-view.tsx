"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { BookingDetail } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Terms } from "@/components/listing/booking-panel";
import { formatINR } from "@/lib/money";
import { formatMmSs, useSecondsLeft } from "./countdown";
import { PaySection } from "./pay-section";

export type CheckoutBooking = Pick<
  BookingDetail,
  | "id"
  | "status"
  | "paymentStatus"
  | "holdExpiresAt"
  | "listing"
  | "rentalType"
  | "startAt"
  | "endAt"
  | "vehicle"
  | "subtotal"
  | "renterFee"
  | "total"
  | "terms"
>;

export function CheckoutView({
  booking,
  serverNow,
  paymentsConfigured,
}: {
  booking: CheckoutBooking;
  /** RAZORPAY_* keys are set on the server. */
  paymentsConfigured: boolean;
  /** Server clock at render time; the hold expires by server time, not the device's. */
  serverNow: string;
}) {
  // Skew = server minus client, measured once on mount. Off by the page's network latency
  // (a second or two), which is fine for a minutes-long hold; the server still decides expiry.
  const [skewMs, setSkewMs] = useState<number>();
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time clock measurement
    setSkewMs(new Date(serverNow).getTime() - Date.now());
  }, [serverNow]);
  const held = booking.status === "PENDING_PAYMENT" && booking.holdExpiresAt !== null;
  const secondsLeft = useSecondsLeft(
    held && skewMs !== undefined ? booking.holdExpiresAt : null,
    skewMs,
  );
  const expired = !held || secondsLeft === 0;
  // While a payment is being confirmed, a lapsing timer is not the outcome: the server decides.
  const [paying, setPaying] = useState(false);
  const refunding = booking.paymentStatus === "CAPTURED_UNFULFILLED";
  const listingHref = `/listings/${booking.listing.id}`;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold">Checkout</h1>

      {booking.status === "CONFIRMED" ? (
        <Alert role="status">
          <AlertTitle>Booking confirmed</AlertTitle>
          <AlertDescription>
            <p>Your payment was received and the space is yours.</p>
            <Link
              href={`/bookings/${booking.id}`}
              className="mt-2 inline-block font-medium underline underline-offset-4"
            >
              View booking and access details
            </Link>
          </AlertDescription>
        </Alert>
      ) : booking.status !== "PENDING_PAYMENT" && booking.status !== "EXPIRED" ? (
        <Alert>
          <AlertTitle>This booking is no longer awaiting payment</AlertTitle>
          <AlertDescription>
            {refunding ? <p>Your payment is being refunded in full.</p> : null}
            <Link href="/bookings" className="underline underline-offset-4">
              See your bookings
            </Link>
          </AlertDescription>
        </Alert>
      ) : paying ? null : expired ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Your hold has expired</AlertTitle>
          <AlertDescription>
            <p>
              The space was released so others can book it.{" "}
              {refunding ? "Your payment is being refunded in full." : "You haven�t been charged."}
            </p>
            <Link
              href={listingHref}
              className="mt-2 inline-block font-medium underline underline-offset-4"
            >
              Start again
            </Link>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="bg-muted rounded-xl p-4">
          <p className="text-sm">We&apos;re holding this space for you for</p>
          <p role="timer" aria-live="off" className="text-3xl font-bold tabular-nums">
            {secondsLeft === null ? "…" : formatMmSs(secondsLeft)}
          </p>
          <p className="text-muted-foreground text-sm">
            Complete payment before the timer runs out.
          </p>
        </div>
      )}

      <section aria-labelledby="summary-title" className="space-y-4 rounded-xl border p-4 sm:p-6">
        <h2 id="summary-title" className="text-xl font-semibold">
          Summary
        </h2>
        <p>
          <Link href={listingHref} className="font-medium underline underline-offset-4">
            {booking.listing.title}
          </Link>
          <span className="text-muted-foreground block text-sm">{booking.listing.locality}</span>
        </p>
        {booking.vehicle ? (
          <p className="text-sm">
            Vehicle: {booking.vehicle.nickname ? `${booking.vehicle.nickname} · ` : ""}
            {booking.vehicle.registration}
          </p>
        ) : null}
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt>Parking</dt>
            <dd>{formatINR(booking.subtotal.paise)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Service fee</dt>
            <dd>{formatINR(booking.renterFee.paise)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
            <dt>Total to pay</dt>
            <dd>{formatINR(booking.total.paise)}</dd>
          </div>
        </dl>
        <Terms quote={booking} />
      </section>

      {booking.status === "PENDING_PAYMENT" ? (
        <section aria-labelledby="pay-title" className="space-y-3 rounded-xl border p-4 sm:p-6">
          <h2 id="pay-title" className="text-xl font-semibold">
            Payment
          </h2>
          <PaySection
            bookingId={booking.id}
            totalPaise={booking.total.paise}
            configured={paymentsConfigured}
            canPay={!expired}
            onBusyChange={setPaying}
          />
        </section>
      ) : null}
    </div>
  );
}

export function CheckoutSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading checkout"
      className="mx-auto max-w-2xl space-y-4"
    >
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
