import type {
  BookingStatus,
  MonthlyAgreementStatus,
  PaymentStatus,
  RefundStatus,
} from "@/generated/prisma/enums";
import { formatIST } from "@/lib/time";

// PRD §5 states in plain language. Records keyed by the enum make typecheck fail on a new state.

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  CONFIRMED: "Confirmed",
  ACTIVE: "Parked now",
  GRACE_PERIOD: "Grace period — please leave",
  OVERSTAY: "Past grace period",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  EXPIRED: "Hold expired",
  PAYMENT_FAILED: "Payment failed",
  DISPUTED: "Under support review",
};

// No "destructive": that badge variant misses 4.5:1 contrast at badge size.
export const BOOKING_STATUS_TONE: Record<BookingStatus, "default" | "secondary" | "outline"> = {
  PENDING_PAYMENT: "outline",
  CONFIRMED: "default",
  ACTIVE: "default",
  GRACE_PERIOD: "outline",
  OVERSTAY: "outline",
  COMPLETED: "secondary",
  CANCELLED: "secondary",
  EXPIRED: "secondary",
  PAYMENT_FAILED: "outline",
  DISPUTED: "outline",
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  ORDER_CREATED: "Payment not completed",
  PENDING: "Payment processing",
  SUCCEEDED: "Paid",
  FAILED: "Payment failed",
};

export const REFUND_STATUS_LABEL: Record<RefundStatus, string> = {
  PENDING: "Refund pending",
  PROCESSING: "Refund processing",
  SUCCEEDED: "Refunded",
  FAILED: "Refund failed — support will follow up",
};

export const MONTHLY_STATUS_LABEL: Record<MonthlyAgreementStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  ACTIVE: "Active",
  NOTICE_GIVEN: "Notice given — ends at term end",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  ENDED: "Ended",
};

/** "Sat 17 Oct, 2:00 PM – 4:00 PM IST", or both dates when the range spans days. */
export function formatRangeIST(startAt: string, endAt: string): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const sameDay = formatIST(start, "yyyy-MM-dd") === formatIST(end, "yyyy-MM-dd");
  return `${formatIST(start, "EEE d MMM, h:mm a")} – ${formatIST(end, sameDay ? "h:mm a" : "EEE d MMM, h:mm a")} IST`;
}

export const formatWhenIST = (iso: string) =>
  `${formatIST(new Date(iso), "EEE d MMM, h:mm a")} IST`;
