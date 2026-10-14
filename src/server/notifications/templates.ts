import { z } from "zod";
import { formatINR } from "@/lib/money";
import { formatIST } from "@/lib/time";

// FR-12 trigger table. Payloads are zod objects (unknown keys are stripped), so an
// address, access instructions, or a phone number passed by a caller is never stored
// or rendered. Access details live behind the authorized booking page (PRD §9).

export type Rendered = {
  /** In-app preview: no address, access instructions, phone, or amounts. */
  title: string;
  body: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
  link: string | null;
};

/** `reminder` emails follow the sessionReminders preference; everything else follows `email`. */
type Category = "transactional" | "reminder";

const Iso = z.iso.datetime();
const id = z.uuid();
const title = z.string().trim().min(1).max(200);

const when = (iso: string) => `${formatIST(new Date(iso), "d MMM yyyy, h:mm a")} IST`;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function make(
  t: { title: string; body: string; subject?: string; extra?: string },
  link: string,
): Rendered {
  const lines = [t.body, t.extra, `Open ParkShare: ${link}`].filter(Boolean) as string[];
  return {
    title: t.title,
    body: t.body,
    emailSubject: t.subject ?? t.title,
    emailText: lines.join("\n\n"),
    emailHtml: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
    link,
  };
}

function template<S extends z.ZodObject>(
  category: Category,
  schema: S,
  render: (p: z.output<S>) => Rendered,
) {
  return { category, schema, render };
}

const booking = z.object({ bookingId: id, listingTitle: title, startAt: Iso, endAt: Iso });
const bookingLink = (p: { bookingId: string }) => `/bookings/${p.bookingId}`;
const monthly = z.object({ agreementId: id, listingTitle: title, endAt: Iso });
const monthlyLink = (p: { agreementId: string }) => `/monthly/${p.agreementId}`;

export const templates = {
  BOOKING_CONFIRMED_RENTER: template("transactional", booking, (p) =>
    make(
      {
        title: "Booking confirmed",
        body: `${p.listingTitle}, ${when(p.startAt)} to ${when(p.endAt)}.`,
        extra: "Your address and access details are on your booking page.",
      },
      bookingLink(p),
    ),
  ),
  BOOKING_CONFIRMED_HOST: template("transactional", booking, (p) =>
    make(
      {
        title: "New booking",
        body: `${p.listingTitle} is booked from ${when(p.startAt)} to ${when(p.endAt)}.`,
      },
      `/host/bookings/${p.bookingId}`,
    ),
  ),
  ARRIVAL_UPCOMING: template("reminder", booking, (p) =>
    make(
      {
        title: "Your parking starts soon",
        body: `${p.listingTitle} at ${when(p.startAt)}.`,
        extra: "Check your booking page for access details.",
      },
      bookingLink(p),
    ),
  ),
  SESSION_ENDING: template(
    "reminder",
    booking.extend({ minutesLeft: z.union([z.literal(30), z.literal(10)]) }),
    (p) =>
      make(
        {
          title: `Parking ends in ${p.minutesLeft} minutes`,
          body: `${p.listingTitle} ends at ${when(p.endAt)}. Extend or leave on time.`,
        },
        bookingLink(p),
      ),
  ),
  GRACE_EXPIRED_RENTER: template("transactional", booking, (p) =>
    make(
      {
        title: "Grace period over",
        body: `Your time at ${p.listingTitle} ended at ${when(p.endAt)}. Please leave or contact support.`,
      },
      bookingLink(p),
    ),
  ),
  GRACE_EXPIRED_HOST: template("transactional", booking, (p) =>
    make(
      {
        title: "Vehicle still parked",
        body: `The booking at ${p.listingTitle} ended at ${when(p.endAt)} and the grace period is over.`,
      },
      `/host/bookings/${p.bookingId}`,
    ),
  ),
  EXTENSION_REQUESTED: template("transactional", booking.extend({ newEndAt: Iso }), (p) =>
    make(
      {
        title: "Extension requested",
        body: `A renter asked to extend ${p.listingTitle} until ${when(p.newEndAt)}.`,
      },
      `/host/bookings/${p.bookingId}`,
    ),
  ),
  EXTENSION_OUTCOME: template("transactional", booking.extend({ approved: z.boolean() }), (p) =>
    make(
      {
        title: p.approved ? "Extension approved" : "Extension declined",
        body: p.approved
          ? `${p.listingTitle} now ends at ${when(p.endAt)}.`
          : `${p.listingTitle} still ends at ${when(p.endAt)}.`,
      },
      bookingLink(p),
    ),
  ),
  CANCELLATION_UPDATE: template(
    "transactional",
    booking.extend({ cancelledBy: z.enum(["RENTER", "HOST", "ADMIN", "SYSTEM"]) }),
    (p) =>
      make(
        {
          title: "Booking cancelled",
          body: `The booking at ${p.listingTitle} for ${when(p.startAt)} was cancelled.`,
          extra: "Any refund follows the cancellation policy shown on your booking page.",
        },
        bookingLink(p),
      ),
  ),
  REFUND_UPDATE: template(
    "transactional",
    z.object({
      bookingId: id,
      status: z.enum(["PENDING", "PROCESSING", "SUCCEEDED", "FAILED"]),
      amountPaise: z.number().int().min(0),
    }),
    (p) =>
      make(
        {
          title: "Refund update",
          body: `Your refund is ${p.status.toLowerCase()}.`,
          // The amount goes in the email only, never the preview.
          extra: `Refund amount: ${formatINR(p.amountPaise)}.`,
        },
        bookingLink(p),
      ),
  ),
  MONTHLY_RENEWAL_DUE: template("reminder", monthly, (p) =>
    make(
      {
        title: "Monthly parking renewal due",
        body: `${p.listingTitle} ends ${when(p.endAt)}. Renew to keep your spot.`,
      },
      monthlyLink(p),
    ),
  ),
  MONTHLY_EXPIRED_RENTER: template("transactional", monthly, (p) =>
    make(
      { title: "Monthly parking ended", body: `${p.listingTitle} ended ${when(p.endAt)}.` },
      monthlyLink(p),
    ),
  ),
  MONTHLY_EXPIRED_HOST: template("transactional", monthly, (p) =>
    make(
      {
        title: "Monthly agreement ended",
        body: `The agreement for ${p.listingTitle} ended ${when(p.endAt)}.`,
      },
      `/host/monthly/${p.agreementId}`,
    ),
  ),
  MONTHLY_NOTICE_GIVEN: template("transactional", monthly, (p) =>
    make(
      {
        title: "Monthly notice given",
        body: `The renter of ${p.listingTitle} gave notice. The agreement ends ${when(p.endAt)}.`,
      },
      `/host/monthly/${p.agreementId}`,
    ),
  ),
  PAYOUT_FAILED_HOST: template("transactional", z.object({ payoutId: id }), () =>
    make(
      {
        title: "Payout failed",
        body: "A payout couldn't be completed. Check your payout details.",
      },
      "/host/earnings",
    ),
  ),
  PAYOUT_FAILED_ADMIN: template("transactional", z.object({ payoutId: id }), (p) =>
    make(
      { title: "Payout failed", body: `Payout ${p.payoutId} failed and needs review.` },
      `/admin/payouts/${p.payoutId}`,
    ),
  ),
};

export type NotificationType = keyof typeof templates;
export type NotificationPayload<T extends NotificationType> = z.input<
  (typeof templates)[T]["schema"]
>;

export function isNotificationType(type: string): type is NotificationType {
  return Object.hasOwn(templates, type);
}

/** Renders a stored notification; a payload that no longer parses gets a generic preview. */
export function renderStored(type: string, payload: unknown): Rendered {
  if (isNotificationType(type)) {
    const t = templates[type];
    const parsed = t.schema.safeParse(payload);
    if (parsed.success) return (t.render as (p: unknown) => Rendered)(parsed.data);
  }
  return make({ title: "ParkShare update", body: "Open ParkShare for details." }, "/");
}
