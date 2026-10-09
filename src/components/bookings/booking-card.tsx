import Link from "next/link";
import type { BookingSummary } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  PAYMENT_STATUS_LABEL,
  REFUND_STATUS_LABEL,
  formatRangeIST,
} from "./labels";

/** Payment and refund badges, shown only when they tell the renter something the booking status doesn't. */
export function MoneyBadges({ b }: { b: Pick<BookingSummary, "paymentStatus" | "refundStatus"> }) {
  return (
    <>
      {b.paymentStatus && b.paymentStatus !== "SUCCEEDED" ? (
        <Badge variant="outline">{PAYMENT_STATUS_LABEL[b.paymentStatus]}</Badge>
      ) : null}
      {b.refundStatus ? (
        <Badge variant="outline">{REFUND_STATUS_LABEL[b.refundStatus]}</Badge>
      ) : null}
    </>
  );
}

export function BookingCard({ booking: b }: { booking: BookingSummary }) {
  return (
    <li>
      <Link
        href={`/bookings/${b.id}`}
        className="hover:bg-muted/50 focus-visible:ring-ring/50 block min-h-11 rounded-xl border p-4 outline-none focus-visible:ring-3"
      >
        <h3 className="text-base font-semibold">{b.listing.title}</h3>
        <p className="text-muted-foreground text-sm">{b.listing.locality}</p>
        <p className="mt-2 text-sm">{formatRangeIST(b.startAt, b.endAt)}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant={BOOKING_STATUS_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Badge>
          <MoneyBadges b={b} />
        </div>
      </Link>
    </li>
  );
}
