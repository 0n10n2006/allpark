import type {
  AdminCreatePayoutBody,
  AdminListPayoutsQuery,
  AdminPayout,
  AdminPayoutReconciliationResponse,
  HostPayout,
  ListHostPayoutsResponse,
  PaginationQuery,
} from "@/contracts";
import { Uuid } from "@/contracts";
import type { Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { notify } from "@/server/notifications";
import { log } from "@/server/payments/log";
import { bookingEarnings } from "./earnings";

// FR-06 AC5/AC6, payoutMode MANUAL (plan §2): an admin creates a payout for a host's
// payable bookings, pays them outside ParkShare, then records the bank/provider reference.
// PENDING → PAID | FAILED. Booking.hostPayoutId is the claim: set once, under row locks,
// so a booking can't be in two live payouts. FAILED releases the claim.

type Tx = Prisma.TransactionClient;
const TX = { maxWait: 15_000, timeout: 20_000 };
const OPEN = ["PENDING", "PROCESSING"];

const payoutInclude = { bookings: { select: { id: true } } } as const;
type PayoutRow = Prisma.HostPayoutGetPayload<{ include: typeof payoutInclude }>;

function toHostPayout(p: PayoutRow): HostPayout {
  return {
    id: p.id,
    amount: { paise: p.amountPaise, currency: "INR" },
    status: p.status,
    providerReference: p.providerReference,
    failureReason: p.failureReason,
    bookingCount: p.bookings.length,
    paidAt: p.paidAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

const toAdminPayout = (p: PayoutRow): AdminPayout => ({
  ...toHostPayout(p),
  hostId: p.hostId,
  bookingIds: p.bookings.map((b) => b.id),
});

/**
 * POST /api/admin/payouts. Locks the requested bookings in id order (no deadlocks between
 * overlapping requests), requires every one to be this host's, COMPLETED, unclaimed, and
 * payable, then claims them all. Any shortfall rolls back with 409, so of two racing
 * payouts over the same booking exactly one wins.
 */
export async function createPayout(
  admin: CurrentUser,
  body: AdminCreatePayoutBody,
  idempotencyKey: string,
): Promise<AdminPayout> {
  const ids = body.bookingIds;
  const notPayable = (bookingIds: string[]) =>
    new HttpError("conflict", "Some bookings can't be paid out", {
      reason: "bookings_not_payable",
      bookingIds,
    });
  const payout = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT b.id FROM "Booking" b JOIN "Listing" l ON l.id = b."listingId"
      WHERE b.id = ANY(${ids}::uuid[]) AND l."hostId" = ${body.hostId}::uuid
        AND b.status = 'COMPLETED' AND b."hostPayoutId" IS NULL
      ORDER BY b.id FOR UPDATE OF b`;
    if (locked.length !== ids.length)
      throw notPayable(ids.filter((id) => !locked.some((l) => l.id === id)));

    const earnings = await bookingEarnings({ hostId: body.hostId, bookingIds: ids }, tx);
    const bad = ids.filter((id) => earnings.find((e) => e.bookingId === id)?.status !== "PAYABLE");
    if (bad.length) throw notPayable(bad);

    const p = await tx.hostPayout.create({
      data: {
        hostId: body.hostId,
        amountPaise: earnings.reduce((s, e) => s + e.net, 0),
        idempotencyKey: `${admin.id}:${idempotencyKey}`,
      },
    });
    const claimed = await tx.$executeRaw`
      UPDATE "Booking" SET "hostPayoutId" = ${p.id}::uuid, "updatedAt" = now()
      WHERE id = ANY(${ids}::uuid[]) AND "hostPayoutId" IS NULL AND status = 'COMPLETED'`;
    if (claimed !== ids.length) throw notPayable(ids);

    await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: "payout.create",
        targetType: "HostPayout",
        targetId: p.id,
        reason: body.reason,
        metadata: {
          hostId: body.hostId,
          amountPaise: p.amountPaise,
          bookings: earnings.map((e) => ({ id: e.bookingId, netPaise: e.net })),
        },
      },
    });
    return tx.hostPayout.findUniqueOrThrow({ where: { id: p.id }, include: payoutInclude });
  }, TX);
  return toAdminPayout(payout);
}

/** Locks an open payout, or throws 404/409. */
async function lockOpenPayout(tx: Tx, id: string) {
  const [p] = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status::text FROM "HostPayout" WHERE id = ${id}::uuid FOR UPDATE`;
  if (!p) throw new HttpError("not_found", "Payout not found");
  if (!OPEN.includes(p.status))
    throw new HttpError("conflict", `Payout is already ${p.status}`, { status: p.status });
}

/**
 * POST /api/admin/payouts/:id/mark-paid. Records the money the admin sent: one HOST_PAYOUT
 * ledger row for the payout amount, referenced by the provider/bank reference (FR-06 AC6).
 */
export async function markPayoutPaid(
  admin: CurrentUser,
  id: string,
  body: { providerReference: string; reason: string },
) {
  return db.$transaction(async (tx) => {
    await lockOpenPayout(tx, id);
    const p = await tx.hostPayout.update({
      where: { id },
      data: {
        status: "PAID",
        providerReference: body.providerReference,
        paidAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    await tx.ledgerEntry.create({
      data: {
        hostPayoutId: id,
        account: "HOST_PAYOUT",
        amountPaise: p.amountPaise,
        currency: p.currency,
        reference: body.providerReference,
        memo: "manual_payout",
      },
    });
    const { id: auditLogId } = await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: "payout.mark_paid",
        targetType: "HostPayout",
        targetId: id,
        reason: body.reason,
        metadata: {
          hostId: p.hostId,
          amountPaise: p.amountPaise,
          providerReference: body.providerReference,
        },
      },
    });
    return { ok: true as const, auditLogId };
  }, TX);
}

/**
 * POST /api/admin/payouts/:id/mark-failed. Releases the bookings (hostPayoutId = NULL) so
 * a new payout can claim them, then tells the host and every admin (FR-12).
 */
export async function markPayoutFailed(admin: CurrentUser, id: string, reason: string) {
  const r = await db.$transaction(async (tx) => {
    await lockOpenPayout(tx, id);
    const bookings = await tx.booking.findMany({
      where: { hostPayoutId: id },
      select: { id: true },
    });
    await tx.booking.updateMany({ where: { hostPayoutId: id }, data: { hostPayoutId: null } });
    const p = await tx.hostPayout.update({
      where: { id },
      data: { status: "FAILED", failureReason: reason, attempts: { increment: 1 } },
    });
    const { id: auditLogId } = await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: "payout.mark_failed",
        targetType: "HostPayout",
        targetId: id,
        reason,
        metadata: {
          hostId: p.hostId,
          amountPaise: p.amountPaise,
          releasedBookingIds: bookings.map((b) => b.id),
        },
      },
    });
    return { hostId: p.hostId, auditLogId };
  }, TX);
  const admins = await db.user.findMany({
    where: { roles: { has: "ADMIN" } },
    select: { id: true },
  });
  await notify(
    r.hostId,
    "PAYOUT_FAILED_HOST",
    { payoutId: id },
    {
      idempotencyKey: `payout:${id}:failed:host`,
    },
  );
  for (const a of admins)
    await notify(
      a.id,
      "PAYOUT_FAILED_ADMIN",
      { payoutId: id },
      {
        idempotencyKey: `payout:${id}:failed:admin:${a.id}`,
      },
    );
  log("warn", "payout.failed", { payoutId: id, hostId: r.hostId });
  return { ok: true as const, auditLogId: r.auditLogId };
}

async function listPayouts(
  where: Prisma.HostPayoutWhereInput,
  q: PaginationQuery,
): Promise<{ rows: PayoutRow[]; nextCursor: string | null }> {
  if (q.cursor && !Uuid.safeParse(q.cursor).success)
    throw new HttpError("validation_error", "Invalid cursor");
  const rows = await db.hostPayout.findMany({
    where,
    include: payoutInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, q.limit);
  return { rows: page, nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
}

/** GET /api/host/payouts: the caller's own payouts. */
export async function listHostPayouts(
  hostId: string,
  q: PaginationQuery,
): Promise<ListHostPayoutsResponse> {
  const { rows, nextCursor } = await listPayouts({ hostId }, q);
  return { items: rows.map(toHostPayout), nextCursor };
}

/** GET /api/admin/payouts */
export async function listAdminPayouts(q: AdminListPayoutsQuery) {
  const { rows, nextCursor } = await listPayouts(
    {
      ...(q.hostId ? { hostId: q.hostId } : {}),
      ...(q.payoutStatus ? { status: q.payoutStatus } : {}),
    },
    q,
  );
  return { items: rows.map(toAdminPayout), nextCursor };
}

/**
 * GET /api/admin/payouts/reconciliation (FR-06 AC6). Per host, from the ledger:
 * outstanding = HOST_EARNINGS − host-borne refunds − HOST_PAYOUT. It must equal the net
 * earnings of the host's bookings that aren't in a PAID payout; a gap (e.g. a refund after
 * the host was paid) is a discrepancy. Each PAID payout must have HOST_PAYOUT rows equal to
 * its amount under its provider reference, and no other payout may have any.
 * ponytail: scans all ledger rows; page by host when that gets slow.
 */
export async function payoutReconciliation(): Promise<AdminPayoutReconciliationResponse> {
  const earnings = await bookingEarnings({});
  const payouts = await db.hostPayout.findMany({
    select: { id: true, hostId: true, status: true, amountPaise: true, providerReference: true },
  });
  const ledger = await db.ledgerEntry.findMany({
    where: { account: "HOST_PAYOUT" },
    select: { hostPayoutId: true, amountPaise: true, reference: true },
  });

  const hosts = new Map<string, AdminPayoutReconciliationResponse["hosts"][number]>();
  const host = (hostId: string) => {
    let h = hosts.get(hostId);
    if (!h) {
      h = {
        hostId,
        hostEarningsPaise: 0,
        hostRefundsPaise: 0,
        paidOutPaise: 0,
        outstandingPaise: 0,
        unpaidBookingsPaise: 0,
        payablePaise: 0,
      };
      hosts.set(hostId, h);
    }
    return h;
  };
  for (const e of earnings) {
    const h = host(e.hostId);
    h.hostEarningsPaise += e.hostEarnings;
    h.hostRefundsPaise += e.hostRefunds;
    if (e.payoutStatus !== "PAID") h.unpaidBookingsPaise += e.net;
    if (e.status === "PAYABLE") h.payablePaise += e.net;
  }

  const discrepancies: AdminPayoutReconciliationResponse["discrepancies"] = [];
  for (const p of payouts) {
    const rows = ledger.filter((l) => l.hostPayoutId === p.id);
    const recorded = rows.reduce((s, l) => s + l.amountPaise, 0);
    host(p.hostId).paidOutPaise += recorded;
    const expected = p.status === "PAID" ? p.amountPaise : 0;
    if (recorded !== expected || rows.some((l) => l.reference !== p.providerReference))
      discrepancies.push({
        kind: "payout_ledger_mismatch",
        hostId: p.hostId,
        payoutId: p.id,
        expectedPaise: expected,
        actualPaise: recorded,
      });
  }

  for (const h of hosts.values()) {
    h.outstandingPaise = h.hostEarningsPaise - h.hostRefundsPaise - h.paidOutPaise;
    if (h.outstandingPaise !== h.unpaidBookingsPaise)
      discrepancies.push({
        kind: "outstanding_mismatch",
        hostId: h.hostId,
        payoutId: null,
        expectedPaise: h.unpaidBookingsPaise,
        actualPaise: h.outstandingPaise,
      });
  }
  return { currency: "INR", hosts: [...hosts.values()], discrepancies };
}
