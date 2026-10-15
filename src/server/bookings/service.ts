import {
  BookingDetail,
  BookingSummary,
  type ListBookingsQuery,
  type ListBookingsResponse,
  Uuid,
} from "@/contracts";
import {
  cancellationText,
  getActivePolicy,
  overstayText,
  POLICY_DEFAULTS,
  type Policy,
} from "@/config/policy";
import type { BookingStatus, Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { createHold } from "@/server/availability/service";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";

const SCOPES: Record<ListBookingsQuery["scope"], BookingStatus[] | undefined> = {
  upcoming: ["PENDING_PAYMENT", "CONFIRMED"],
  active: ["ACTIVE", "GRACE_PERIOD", "OVERSTAY", "DISPUTED"],
  past: ["COMPLETED", "CANCELLED", "EXPIRED", "PAYMENT_FAILED"],
  all: undefined,
};

/** FR-01 AC4: precise address and instructions only once inventory is committed. */
const ACCESS_STATUSES: BookingStatus[] = [
  "CONFIRMED",
  "ACTIVE",
  "GRACE_PERIOD",
  "OVERSTAY",
  "COMPLETED",
  "DISPUTED",
];
/** L7 (PRD §9): once the session is over the renter keeps access details for a day; the host always. */
const RENTER_ACCESS_AFTER_END_MS = 24 * 3600_000;

const summaryInclude = {
  listing: {
    select: {
      id: true,
      title: true,
      locality: true,
      hostId: true,
      photos: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], take: 1 },
    },
  },
  payments: {
    orderBy: { createdAt: "desc" },
    take: 1,
    include: { refunds: { orderBy: { createdAt: "desc" }, take: 1 } },
  },
} satisfies Prisma.BookingInclude;

const detailInclude = {
  ...summaryInclude,
  listing: {
    select: {
      ...summaryInclude.listing.select,
      address: true,
      lat: true,
      lng: true,
      accessInstructions: true,
      cancellationPolicy: true,
      host: { select: { name: true, phone: true, email: true } },
    },
  },
  vehicle: { select: { id: true, registration: true, nickname: true } },
  monthlyAgreement: {
    select: { id: true, status: true, currentTermEndAt: true, renewalDueAt: true },
  },
  quote: { select: { policyVersion: { select: { policy: true } } } },
} satisfies Prisma.BookingInclude;

type SummaryRow = Prisma.BookingGetPayload<{ include: typeof summaryInclude }>;
type DetailRow = Prisma.BookingGetPayload<{ include: typeof detailInclude }>;

const money = (paise: number) => ({ paise, currency: "INR" as const });

function summary(b: SummaryRow): BookingSummary {
  const payment = b.payments[0];
  return {
    id: b.id,
    listing: {
      id: b.listing.id,
      title: b.listing.title,
      locality: b.listing.locality,
      photoUrl: b.listing.photos[0]?.url ?? null,
    },
    rentalType: b.rentalType,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    status: b.status,
    paymentStatus: payment?.status ?? null,
    refundStatus: payment?.refunds[0]?.status ?? null,
    total: money(b.totalPaise),
    holdExpiresAt:
      b.status === "PENDING_PAYMENT" && b.holdExpiresAt ? b.holdExpiresAt.toISOString() : null,
  };
}

async function detail(b: DetailRow, viewer: CurrentUser): Promise<BookingDetail> {
  // Terms as agreed: the policy version the quote was priced under.
  const policy: Policy = b.quote
    ? { ...POLICY_DEFAULTS, ...(b.quote.policyVersion.policy as Partial<Policy>) }
    : await getActivePolicy();
  const isHost = viewer.id === b.listing.hostId;
  const isRenter = viewer.id === b.renterId;
  const seesMoney = isHost || viewer.roles.includes("ADMIN");
  const l = b.listing;
  // Parsing strips any field the contract lacks, so nothing private leaks by accident.
  return BookingDetail.parse({
    ...summary(b),
    renterId: b.renterId,
    vehicle: b.vehicle,
    subtotal: money(b.subtotalPaise),
    renterFee: money(b.renterFeePaise),
    commission: seesMoney ? money(b.commissionPaise) : null,
    hostEarnings: seesMoney ? money(b.hostEarningsPaise) : null,
    terms: {
      cancellation: cancellationText(policy, l.cancellationPolicy, b.rentalType),
      overstay: overstayText(policy),
      gracePeriodMinutes: policy.gracePeriodMinutes,
    },
    gracePeriodEndsAt: new Date(
      b.endAt.getTime() + policy.gracePeriodMinutes * 60_000,
    ).toISOString(),
    checkedInAt: b.checkedInAt?.toISOString() ?? null,
    checkedOutAt: b.checkedOutAt?.toISOString() ?? null,
    cancelledAt: b.cancelledAt?.toISOString() ?? null,
    cancellationReason: b.cancellationReason,
    monthlyAgreement: b.monthlyAgreement && {
      ...b.monthlyAgreement,
      currentTermEndAt: b.monthlyAgreement.currentTermEndAt.toISOString(),
      renewalDueAt: b.monthlyAgreement.renewalDueAt?.toISOString() ?? null,
    },
    access:
      ACCESS_STATUSES.includes(b.status) &&
      (isHost ||
        (isRenter &&
          (!["COMPLETED", "DISPUTED"].includes(b.status) ||
            Date.now() < b.endAt.getTime() + RENTER_ACCESS_AFTER_END_MS)))
        ? {
            address: l.address,
            lat: l.lat,
            lng: l.lng,
            accessInstructions: l.accessInstructions,
            hostContact: l.host,
          }
        : null,
    createdAt: b.createdAt.toISOString(),
  });
}

/** GET /api/bookings/:id. Renter, the listing's host, or an admin; anyone else gets 404. */
export async function getBooking(id: string, viewer: CurrentUser): Promise<BookingDetail> {
  const b = await db.booking.findUnique({ where: { id }, include: detailInclude });
  if (
    !b ||
    !(b.renterId === viewer.id || b.listing.hostId === viewer.id || viewer.roles.includes("ADMIN"))
  )
    throw new HttpError("not_found", "Booking not found");
  return detail(b, viewer);
}

/** GET /api/bookings: the caller's bookings as renter or host, newest start first. */
export async function listBookings(
  viewer: CurrentUser,
  q: ListBookingsQuery,
): Promise<ListBookingsResponse> {
  if (q.cursor && !Uuid.safeParse(q.cursor).success)
    throw new HttpError("validation_error", "Invalid cursor");
  const statuses = SCOPES[q.scope];
  const rows = await db.booking.findMany({
    where: {
      ...(q.as === "host" ? { listing: { hostId: viewer.id } } : { renterId: viewer.id }),
      ...(statuses ? { status: { in: statuses } } : {}),
    },
    include: summaryInclude,
    orderBy: [{ startAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((b) => BookingSummary.parse(summary(b))),
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

/** POST /api/bookings/hold: the quote supplies listing, interval, rental type, and vehicle. */
export async function holdFromQuote(
  user: CurrentUser,
  quoteId: string,
  idempotencyKey: string,
): Promise<BookingDetail> {
  const quote = await db.priceQuote.findUnique({ where: { id: quoteId } });
  // Same message as validateQuote: never reveal whether someone else's quote exists.
  if (!quote || quote.renterId !== user.id)
    throw new HttpError("unprocessable", "Quote not found", { reason: "quote_invalid" });
  const booking = await createHold({
    listingId: quote.listingId,
    renterId: user.id,
    vehicleId: quote.vehicleId,
    rentalType: quote.rentalType,
    startAt: quote.startAt,
    endAt: quote.endAt,
    quoteId: quote.id,
    idempotencyKey,
  });
  return getBooking(booking.id, user);
}
