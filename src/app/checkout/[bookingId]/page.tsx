import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { Uuid } from "@/contracts";
import { CheckoutSkeleton, CheckoutView } from "@/components/checkout/checkout-view";
import { getCurrentUser } from "@/server/auth/guards";
import { getBooking } from "@/server/bookings/service";
import { HttpError } from "@/server/http/errors";

export const metadata: Metadata = { title: "Checkout" };

// cacheComponents: params, cookies, and the clock are request data, so read them in Suspense.
export default function CheckoutPage(props: PageProps<"/checkout/[bookingId]">) {
  return (
    <Suspense fallback={<CheckoutSkeleton />}>
      <CheckoutContent {...props} />
    </Suspense>
  );
}

async function CheckoutContent({ params }: PageProps<"/checkout/[bookingId]">) {
  const { bookingId } = await params;
  // /checkout isn't behind the proxy matcher, so the page enforces sign-in itself.
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?callbackUrl=${encodeURIComponent(`/checkout/${bookingId}`)}`);
  if (!Uuid.safeParse(bookingId).success) notFound();
  const booking = await getBooking(bookingId, user).catch((e) => {
    if (e instanceof HttpError && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  });
  if (booking.renterId !== user.id) notFound();

  return (
    <CheckoutView
      // Only renter-facing fields cross to the client; commission/host earnings never do.
      booking={{
        id: booking.id,
        status: booking.status,
        holdExpiresAt: booking.holdExpiresAt,
        listing: booking.listing,
        rentalType: booking.rentalType,
        startAt: booking.startAt,
        endAt: booking.endAt,
        vehicle: booking.vehicle,
        subtotal: booking.subtotal,
        renterFee: booking.renterFee,
        total: booking.total,
        terms: booking.terms,
      }}
      serverNow={new Date().toISOString()}
    />
  );
}
