import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, SearchX } from "lucide-react";
import { type BookingDetail, Uuid } from "@/contracts";
import { EmptyState } from "@/components/common/empty-state";
import { LoadingState } from "@/components/common/loading-state";
import { MoneyBadges } from "@/components/bookings/booking-card";
import { BookingSession } from "@/components/bookings/booking-session";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_TONE } from "@/components/bookings/labels";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatINR } from "@/lib/money";
import { getCurrentUser } from "@/server/auth/guards";
import { getBooking } from "@/server/bookings/service";
import { HttpError } from "@/server/http/errors";

export const metadata: Metadata = { title: "Booking" };

// cacheComponents: params and the session are request data, so both are read inside Suspense.
export default function BookingPage(props: PageProps<"/bookings/[id]">) {
  return (
    <>
      <Link
        href="/bookings"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-1 text-sm"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> All bookings
      </Link>
      <Suspense fallback={<LoadingState label="Loading booking" />}>
        <BookingContent {...props} />
      </Suspense>
    </>
  );
}

async function load(id: string): Promise<BookingDetail | null> {
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?callbackUrl=${encodeURIComponent(`/bookings/${id}`)}`);
  if (!Uuid.safeParse(id).success) return null;
  try {
    return await getBooking(id, user);
  } catch (e) {
    if (e instanceof HttpError && e.code === "not_found") return null;
    throw e;
  }
}

async function BookingContent({ params }: PageProps<"/bookings/[id]">) {
  const { id } = await params;
  const b = await load(id);
  if (!b)
    return (
      <>
        <h1 className="sr-only">Booking not found</h1>
        <div className="mt-6">
          <EmptyState
            icon={SearchX}
            title="We couldn't find that booking"
            body="It may have been removed, or it belongs to a different account."
            action={
              <Link href="/bookings" className={buttonVariants({ className: "h-11 px-4" })}>
                Back to your bookings
              </Link>
            }
          />
        </div>
      </>
    );

  return (
    <article>
      <header className="mt-2">
        <h1 className="text-2xl font-bold md:text-3xl">{b.listing.title}</h1>
        <p className="text-muted-foreground">{b.listing.locality}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge variant={BOOKING_STATUS_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Badge>
          <MoneyBadges b={b} />
        </div>
      </header>

      <BookingSession booking={b} />

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <AccessCard b={b} />
        <Receipt b={b} />
      </div>
    </article>
  );
}

function AccessCard({ b }: { b: BookingDetail }) {
  // Hidden once the stay is over, even though the API still returns it for COMPLETED.
  const a = b.status === "COMPLETED" ? null : b.access;
  return (
    <section aria-labelledby="access-title" className="rounded-xl border p-4">
      <h2 id="access-title" className="text-lg font-semibold">
        Getting in
      </h2>
      {a ? (
        <dl className="mt-2 grid gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Address</dt>
            <dd className="break-words">{a.address}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Access instructions</dt>
            <dd className="break-words whitespace-pre-line">
              {a.accessInstructions ??
                "The host hasn't added instructions. Contact them if you need help."}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Host</dt>
            <dd className="grid gap-1">
              {a.hostContact.name ? <span>{a.hostContact.name}</span> : null}
              {a.hostContact.phone ? (
                <a
                  className="text-primary inline-flex min-h-11 items-center underline"
                  href={`tel:${a.hostContact.phone}`}
                >
                  Call {a.hostContact.phone}
                </a>
              ) : null}
              {a.hostContact.email ? (
                <a
                  className="text-primary inline-flex min-h-11 items-center break-all underline"
                  href={`mailto:${a.hostContact.email}`}
                >
                  {a.hostContact.email}
                </a>
              ) : null}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-muted-foreground mt-2 text-sm" data-testid="access-pending">
          {b.status === "PENDING_PAYMENT"
            ? "The exact address, access instructions and host contact appear here once your payment is confirmed."
            : b.status === "COMPLETED"
              ? "Access details are no longer shown because this booking has ended."
              : "Access details are only shown for confirmed bookings."}
        </p>
      )}
    </section>
  );
}

function Receipt({ b }: { b: BookingDetail }) {
  return (
    <section aria-labelledby="receipt-title" className="rounded-xl border p-4">
      <h2 id="receipt-title" className="text-lg font-semibold">
        Receipt
      </h2>
      {/* ponytail: BookingDetail carries no line items yet, so this shows the stored subtotal/fee/total. */}
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt>Parking</dt>
        <dd className="text-right tabular-nums">{formatINR(b.subtotal.paise)}</dd>
        {b.renterFee.paise > 0 ? (
          <>
            <dt>Service fee</dt>
            <dd className="text-right tabular-nums">{formatINR(b.renterFee.paise)}</dd>
          </>
        ) : null}
        <dt className="border-t pt-1 font-semibold">Total</dt>
        <dd className="border-t pt-1 text-right font-semibold tabular-nums">
          {formatINR(b.total.paise)}
        </dd>
      </dl>
      {b.vehicle ? (
        <p className="text-muted-foreground mt-3 text-sm">
          Vehicle: {b.vehicle.nickname ? `${b.vehicle.nickname} · ` : ""}
          {b.vehicle.registration}
        </p>
      ) : null}
      <h3 className="mt-4 text-sm font-semibold">Your terms</h3>
      <p className="text-muted-foreground mt-1 text-sm">{b.terms.cancellation}</p>
      <p className="text-muted-foreground mt-1 text-sm">{b.terms.overstay}</p>
    </section>
  );
}
