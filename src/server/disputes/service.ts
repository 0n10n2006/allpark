import {
  type AdminDispute,
  AdminDisputeDetail,
  type AdminListDisputesQuery,
  type AdminListDisputesResponse,
  type AdminResolveDisputeBody,
  type CreateDisputeBody,
  Dispute,
  type PaginationQuery,
  type ListMyDisputesResponse,
  Uuid,
} from "@/contracts";
import type { BookingStatus, Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { getBooking } from "@/server/bookings/service";
import { transition } from "@/server/bookings/state";
import { cancelBookingReminders, sendCancellationUpdate } from "@/server/cancellations/notify";
import { refundablePayment } from "@/server/cancellations/service";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { createRefundTx } from "@/server/payments/refunds";

// FR-08, FR-10, FR-13. A dispute is tracked on its own row; only a booking in session
// (ACTIVE / GRACE_PERIOD / OVERSTAY) moves to DISPUTED. Resolving never charges the renter.

/** Session states a dispute pulls into DISPUTED; any other booking state is left alone. */
const DISPUTABLE: BookingStatus[] = ["ACTIVE", "GRACE_PERIOD", "OVERSTAY"];

type DisputeRow = Prisma.DisputeGetPayload<object>;

const toDispute = (d: DisputeRow): Dispute =>
  Dispute.parse({
    ...d,
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  });

/** Evidence must be an image we host: `<cloud>/image/upload/[v123/]disputes/<bookingId>/<id>.<ext>`. */
export function isEvidenceUrl(url: string, bookingId: string) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^https://res\\.cloudinary\\.com/${esc(cloud)}/image/upload/(?:v\\d+/)?disputes/${bookingId}/[A-Za-z0-9_-]+\\.(?:jpg|png|webp)$`,
  ).test(url);
}

/** POST /api/disputes. Renter or host of the booking; anyone else gets 404. */
export async function createDispute(user: CurrentUser, body: CreateDisputeBody): Promise<Dispute> {
  const b = await db.booking.findUnique({
    where: { id: body.bookingId },
    select: { id: true, status: true, renterId: true, listing: { select: { hostId: true } } },
  });
  if (!b || (b.renterId !== user.id && b.listing.hostId !== user.id))
    throw new HttpError("not_found", "Booking not found");
  const evidenceUrls = body.evidenceUrls ?? [];
  if (evidenceUrls.some((u) => !isEvidenceUrl(u, b.id)))
    throw new HttpError("validation_error", "Evidence must be uploaded through ParkShare", {
      reason: "evidence_url_not_allowed",
    });

  const dispute = await db.$transaction(async (tx) => {
    const d = await tx.dispute.create({
      data: {
        bookingId: b.id,
        raisedById: user.id,
        category: body.category,
        description: body.description,
        evidenceUrls,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: "dispute.open",
        targetType: "Dispute",
        targetId: d.id,
        metadata: { bookingId: b.id, category: body.category },
      },
    });
    if (DISPUTABLE.includes(b.status))
      await transition(tx, b.id, "DISPUTED", user.id, `dispute:${d.id}`);
    return d;
  });
  return toDispute(dispute);
}

function cursorArgs(
  cursor: string | undefined,
): Pick<Prisma.DisputeFindManyArgs, "cursor" | "skip"> {
  if (cursor && !Uuid.safeParse(cursor).success)
    throw new HttpError("validation_error", "Invalid cursor");
  return cursor ? { cursor: { id: cursor }, skip: 1 } : {};
}

const newestFirst = [
  { createdAt: "desc" },
  { id: "desc" },
] satisfies Prisma.DisputeOrderByWithRelationInput[];

/** GET /api/disputes: disputes on bookings where the caller is the renter or the host. */
export async function listMyDisputes(
  user: CurrentUser,
  q: PaginationQuery,
): Promise<ListMyDisputesResponse> {
  const rows = await db.dispute.findMany({
    where: {
      OR: [
        { raisedById: user.id },
        { booking: { renterId: user.id } },
        { booking: { listing: { hostId: user.id } } },
      ],
    },
    orderBy: newestFirst,
    take: q.limit + 1,
    ...cursorArgs(q.cursor),
  });
  const items = rows.slice(0, q.limit);
  return {
    items: items.map(toDispute),
    nextCursor: rows.length > q.limit ? items.at(-1)!.id : null,
  };
}

async function adminDispute(
  d: DisputeRow & { booking: { listing: { hostId: string } } },
  admin: CurrentUser,
): Promise<AdminDispute> {
  return {
    ...toDispute(d),
    booking: { ...(await getBooking(d.bookingId, admin)), hostId: d.booking.listing.hostId },
  };
}

const withHost = { booking: { select: { listing: { select: { hostId: true } } } } } as const;

/** GET /api/admin/disputes: the support queue, newest first. */
export async function adminListDisputes(
  admin: CurrentUser,
  q: AdminListDisputesQuery,
): Promise<AdminListDisputesResponse> {
  const rows = await db.dispute.findMany({
    where: {
      ...(q.disputeStatus ? { status: q.disputeStatus } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
    },
    include: withHost,
    orderBy: newestFirst,
    take: q.limit + 1,
    ...cursorArgs(q.cursor),
  });
  const items = rows.slice(0, q.limit);
  // ponytail: one getBooking per row (≤ 100); batch it if the queue page gets slow.
  return {
    items: await Promise.all(items.map((d) => adminDispute(d, admin))),
    nextCursor: rows.length > q.limit ? items.at(-1)!.id : null,
  };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** GET /api/admin/disputes/:id: the dispute plus every linked record, oldest first. */
export async function adminGetDispute(id: string, admin: CurrentUser): Promise<AdminDisputeDetail> {
  const d = await db.dispute.findUnique({ where: { id }, include: withHost });
  if (!d) throw new HttpError("not_found", "Dispute not found");
  const [payments, disputes] = await Promise.all([
    db.payment.findMany({
      where: { bookingId: d.bookingId },
      include: { refunds: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    db.dispute.findMany({ where: { bookingId: d.bookingId }, select: { id: true } }),
  ]);
  // Every record linked to the booking: itself, its payments and refunds, and all its disputes.
  const linkedIds = [
    d.bookingId,
    ...disputes.map((x) => x.id),
    ...payments.flatMap((p) => [p.id, ...p.refunds.map((r) => r.id)]),
  ];
  const [notifications, auditLog] = await Promise.all([
    db.notification.findMany({
      where: { payload: { path: ["bookingId"], equals: d.bookingId } },
      orderBy: { createdAt: "asc" },
    }),
    db.auditLog.findMany({
      where: { targetId: { in: linkedIds } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return AdminDisputeDetail.parse({
    ...(await adminDispute(d, admin)),
    payments: payments.map((p) => ({
      ...p,
      amount: { paise: p.amountPaise, currency: p.currency },
      signatureVerifiedAt: iso(p.signatureVerifiedAt),
      reconciledAt: iso(p.reconciledAt),
      createdAt: p.createdAt.toISOString(),
      refunds: p.refunds.map((r) => ({
        ...r,
        amount: { paise: r.amountPaise, currency: r.currency },
        reconciledAt: iso(r.reconciledAt),
        createdAt: r.createdAt.toISOString(),
      })),
    })),
    notifications: notifications.map((n) => ({
      ...n,
      scheduledAt: n.scheduledAt.toISOString(),
      sentAt: iso(n.sentAt),
    })),
    auditLog: auditLog.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
  });
}

/**
 * POST /api/admin/disputes/:id/resolve (FR-13): reason required, audited with the actor.
 * Closing (RESOLVED/REJECTED) may refund the renter and must say where a DISPUTED booking
 * goes (COMPLETED or CANCELLED). Never charges or penalizes anyone (FR-08).
 */
export async function resolveDispute(
  id: string,
  admin: CurrentUser,
  body: AdminResolveDisputeBody,
): Promise<{ ok: true; auditLogId: string }> {
  const closing = body.outcome !== "UNDER_REVIEW";
  if (!closing && (body.refundPaise || body.bookingOutcome))
    throw new HttpError("validation_error", "Refunds and booking outcomes need a closing decision");

  const result = await db.$transaction(async (tx) => {
    // Row lock: two admins can't both close the same dispute.
    const [d] = await tx.$queryRaw<{ id: string; bookingId: string; status: string }[]>`
      SELECT id, "bookingId", status::text FROM "Dispute" WHERE id = ${id}::uuid FOR UPDATE`;
    if (!d) throw new HttpError("not_found", "Dispute not found");
    if (d.status === "RESOLVED" || d.status === "REJECTED")
      throw new HttpError("conflict", "This dispute is already closed", {
        reason: "dispute_closed",
      });
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: d.bookingId },
      select: { status: true },
    });
    const bookingOutcome =
      closing && booking.status === "DISPUTED" ? body.bookingOutcome : undefined;
    if (closing && booking.status === "DISPUTED" && !bookingOutcome)
      throw new HttpError(
        "validation_error",
        "Choose whether the booking completes or is cancelled",
        {
          reason: "booking_outcome_required",
        },
      );

    let refundId: string | null = null;
    if (body.refundPaise) {
      const paid = await refundablePayment(tx, d.bookingId);
      if (!paid)
        throw new HttpError("unprocessable", "This booking has no captured payment to refund", {
          reason: "nothing_to_refund",
        });
      refundId = (
        await createRefundTx(tx, {
          paymentId: paid.payment.id,
          amountPaise: body.refundPaise,
          reason: "dispute_resolution",
          actorId: admin.id,
          idempotencyKey: `dispute:${id}`,
        })
      ).id;
    }
    if (bookingOutcome) await transition(tx, d.bookingId, bookingOutcome, admin.id, body.reason);
    await tx.dispute.update({
      where: { id },
      data: {
        status: body.outcome,
        resolution: body.resolution,
        ...(closing ? { resolvedById: admin.id, resolvedAt: new Date() } : {}),
      },
    });
    const log = await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: `dispute.${body.outcome.toLowerCase()}`,
        targetType: "Dispute",
        targetId: id,
        reason: body.reason,
        metadata: {
          bookingId: d.bookingId,
          refundPaise: body.refundPaise ?? null,
          refundId,
          bookingOutcome: bookingOutcome ?? null,
        },
      },
    });
    return {
      auditLogId: log.id,
      bookingId: d.bookingId,
      cancelled: bookingOutcome === "CANCELLED",
    };
  });

  if (result.cancelled) {
    const b = await db.booking.findUniqueOrThrow({
      where: { id: result.bookingId },
      select: {
        renterId: true,
        startAt: true,
        endAt: true,
        listing: { select: { hostId: true, title: true } },
      },
    });
    await cancelBookingReminders(result.bookingId);
    await sendCancellationUpdate([b.renterId, b.listing.hostId], {
      bookingId: result.bookingId,
      listingTitle: b.listing.title,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      cancelledBy: "ADMIN",
    });
  }
  return { ok: true, auditLogId: result.auditLogId };
}
