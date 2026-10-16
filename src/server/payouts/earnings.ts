import type { EarningStatus, HostEarningsQuery, HostEarningsResponse } from "@/contracts";
import { getActivePolicy } from "@/config/policy";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";

// FR-06. Host earnings come from the T4.1 ledger, never from client input or Booking totals.

type Tx = Prisma.TransactionClient;

export type BookingEarning = {
  bookingId: string;
  hostId: string;
  listingTitle: string;
  startAt: Date;
  endAt: Date;
  bookingStatus: string;
  hostPayoutId: string | null;
  payoutStatus: string | null;
  gross: number;
  commission: number;
  hostEarnings: number;
  hostRefunds: number;
  net: number;
  status: EarningStatus;
};

/**
 * The host's share of a refund. Refunds come out of the host's and the platform's shares
 * pro rata: share = refund × HOST_EARNINGS / gross, where gross = HOST_EARNINGS +
 * PLATFORM_COMMISSION. A cancellation tier that refunds refundBps of the total therefore
 * costs the host refundBps of their earnings: a full refund leaves them nothing, a 50%
 * refund leaves them half. Only refunds against the booking's SUCCEEDED payment are
 * host-borne. Refunds of duplicate or unfulfilled captures (CAPTURED_UNFULFILLED) net their
 * own unsplit RENTER_PAYMENT and never touch host earnings.
 * Applied per refund, so the earnings view and reconciliation round identically.
 */
export function hostRefundShare(refundPaise: number, hostEarnings: number, gross: number) {
  return gross > 0 ? Math.round((refundPaise * hostEarnings) / gross) : 0;
}

type Filter = { hostId?: string; bookingIds?: string[]; from?: Date; to?: Date };

/**
 * Per-booking earnings for every booking with HOST_EARNINGS ledger rows, filtered by host,
 * ids, or start time. Pass `tx` to read under the caller's locks.
 * ponytail: no pagination; a host with thousands of bookings needs a paged list.
 */
export async function bookingEarnings(f: Filter, tx: Tx = db): Promise<BookingEarning[]> {
  const { payoutHoldbackHours } = await getActivePolicy();
  const where = [
    Prisma.sql`TRUE`,
    f.hostId ? Prisma.sql`l."hostId" = ${f.hostId}::uuid` : null,
    f.bookingIds ? Prisma.sql`b.id = ANY(${f.bookingIds}::uuid[])` : null,
    f.from ? Prisma.sql`b."startAt" >= ${f.from}` : null,
    f.to ? Prisma.sql`b."startAt" < ${f.to}` : null,
  ].filter((x) => x !== null);
  const rows = await tx.$queryRaw<
    {
      bookingId: string;
      hostId: string;
      listingTitle: string;
      startAt: Date;
      endAt: Date;
      bookingStatus: string;
      hostPayoutId: string | null;
      payoutStatus: string | null;
      pastHoldback: boolean;
      refundInFlight: boolean;
      hostEarnings: number;
      commission: number;
    }[]
  >`
    SELECT b.id AS "bookingId", l."hostId", l.title AS "listingTitle", b."startAt", b."endAt",
      b.status::text AS "bookingStatus", b."hostPayoutId", hp.status::text AS "payoutStatus",
      ((b.status = 'COMPLETED' AND COALESCE(b."checkedOutAt", b."endAt")
        <= now() - make_interval(hours => ${payoutHoldbackHours}))
       OR (b.status = 'CANCELLED' AND COALESCE(b."cancelledAt", b."endAt")
        <= now() - make_interval(hours => ${payoutHoldbackHours}))) AS "pastHoldback",
      EXISTS (SELECT 1 FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId"
        WHERE p."bookingId" = b.id AND p.status = 'SUCCEEDED'
          AND r.status IN ('PENDING', 'PROCESSING')) AS "refundInFlight",
      SUM(le."amountPaise") FILTER (WHERE le.account = 'HOST_EARNINGS')::int AS "hostEarnings",
      COALESCE(SUM(le."amountPaise") FILTER (WHERE le.account = 'PLATFORM_COMMISSION'), 0)::int
        AS commission
    FROM "Booking" b
    JOIN "Listing" l ON l.id = b."listingId"
    JOIN "LedgerEntry" le ON le."bookingId" = b.id
    LEFT JOIN "HostPayout" hp ON hp.id = b."hostPayoutId"
    WHERE ${Prisma.join(where, " AND ")}
    GROUP BY b.id, l."hostId", l.title, hp.status
    HAVING SUM(le."amountPaise") FILTER (WHERE le.account = 'HOST_EARNINGS') IS NOT NULL
    ORDER BY b."startAt" DESC, b.id`;
  if (rows.length === 0) return [];

  const refunds = await tx.$queryRaw<{ bookingId: string; amountPaise: number }[]>`
    SELECT le."bookingId", le."amountPaise" FROM "LedgerEntry" le
    JOIN "Refund" r ON r."providerRefundId" = le.reference
    JOIN "Payment" p ON p.id = r."paymentId"
    WHERE le.account = 'REFUND' AND p.status = 'SUCCEEDED'
      AND le."bookingId" = ANY(${rows.map((r) => r.bookingId)}::uuid[])`;

  return rows.map((r) => {
    const gross = r.hostEarnings + r.commission;
    const hostRefunds = Math.min(
      r.hostEarnings,
      refunds
        .filter((x) => x.bookingId === r.bookingId)
        .reduce((sum, x) => sum + hostRefundShare(x.amountPaise, r.hostEarnings, gross), 0),
    );
    const net = r.hostEarnings - hostRefunds;
    const status: EarningStatus = r.hostPayoutId
      ? "PAID"
      : r.pastHoldback && !r.refundInFlight && net > 0
        ? "PAYABLE"
        : "PENDING";
    return {
      bookingId: r.bookingId,
      hostId: r.hostId,
      listingTitle: r.listingTitle,
      startAt: r.startAt,
      endAt: r.endAt,
      bookingStatus: r.bookingStatus,
      hostPayoutId: r.hostPayoutId,
      payoutStatus: r.payoutStatus,
      gross,
      commission: r.commission,
      hostEarnings: r.hostEarnings,
      hostRefunds,
      net,
      status,
    };
  });
}

const inr = (paise: number) => ({ paise, currency: "INR" as const });
const sum = (xs: BookingEarning[], f: (x: BookingEarning) => number) =>
  xs.reduce((s, x) => s + f(x), 0);

/** GET /api/host/earnings: totals by status bucket plus the per-booking list. */
export async function hostEarningsSummary(
  hostId: string,
  q: HostEarningsQuery = {},
): Promise<HostEarningsResponse> {
  const rows = await bookingEarnings({
    hostId,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
  });
  const bucket = (s: EarningStatus) =>
    sum(
      rows.filter((r) => r.status === s),
      (r) => r.net,
    );
  const pending = bucket("PENDING");
  const payable = bucket("PAYABLE");
  return {
    from: q.from ?? null,
    to: q.to ?? null,
    gross: inr(sum(rows, (r) => r.gross)),
    commission: inr(sum(rows, (r) => r.commission)),
    refunds: inr(sum(rows, (r) => r.hostRefunds)),
    hostEarnings: inr(sum(rows, (r) => r.net)),
    paidOut: inr(bucket("PAID")),
    pendingPayout: inr(pending + payable),
    bookingCount: rows.length,
    pending: inr(pending),
    payable: inr(payable),
    payoutMode: (await getActivePolicy()).payoutMode,
    bookings: rows.map((r) => ({
      bookingId: r.bookingId,
      listingTitle: r.listingTitle,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      bookingStatus: r.bookingStatus as HostEarningsResponse["bookings"][number]["bookingStatus"],
      gross: inr(r.gross),
      commission: inr(r.commission),
      hostRefunds: inr(r.hostRefunds),
      net: inr(r.net),
      status: r.status,
      hostPayoutId: r.hostPayoutId,
      payoutStatus: r.payoutStatus as HostEarningsResponse["bookings"][number]["payoutStatus"],
    })),
  };
}
