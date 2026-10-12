import {
  type AdminBooking,
  type AdminDashboardStats,
  type AdminJob,
  type AdminListBookingsQuery,
  type AdminListBookingsResponse,
  type AdminListJobsQuery,
  type AdminListJobsResponse,
  type AdminListListingsQuery,
  type AdminListListingsResponse,
  type AdminListPaymentsQuery,
  type AdminListPaymentsResponse,
  type AdminListUsersQuery,
  type AdminListUsersResponse,
  type AdminListing,
  type AdminPayment,
  type AdminRefund,
  AdminUser,
  Uuid,
} from "@/contracts";
import { getActivePolicy } from "@/config/policy";
import type { Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { getBooking } from "@/server/bookings/service";
import { db } from "@/server/db";
import { audit } from "@/server/http/audit";
import { HttpError } from "@/server/http/errors";
import {
  setHostVerification,
  suspendListing,
  toOwned,
} from "@/server/listings/service";

function validateCursor(cursor: string | undefined) {
  if (cursor && !Uuid.safeParse(cursor).success) {
    throw new HttpError("validation_error", "Invalid cursor");
  }
}

// ── Dashboard Stats ──

export async function adminGetStats(): Promise<AdminDashboardStats> {
  const [
    openDisputesCount,
    openReportsCount,
    pendingHostVerificationsCount,
    pendingPayoutsCount,
    deadJobsCount,
    failedNotificationsCount,
  ] = await Promise.all([
    db.dispute.count({ where: { status: "OPEN" } }),
    db.report.count({ where: { status: "OPEN" } }),
    db.user.count({ where: { hostVerificationStatus: "PENDING" } }),
    db.hostPayout.count({ where: { status: "PENDING" } }),
    db.job.count({ where: { status: { in: ["DEAD", "FAILED"] } } }),
    db.notification.count({ where: { status: "FAILED" } }),
  ]);

  return {
    openDisputesCount,
    openReportsCount,
    pendingHostVerificationsCount,
    pendingPayoutsCount,
    deadJobsCount,
    failedNotificationsCount,
  };
}

// ── Users ──

export async function adminListUsers(q: AdminListUsersQuery): Promise<AdminListUsersResponse> {
  validateCursor(q.cursor);
  const where: Prisma.UserWhereInput = {
    ...(q.role ? { roles: { has: q.role } } : {}),
    ...(q.hostVerificationStatus ? { hostVerificationStatus: q.hostVerificationStatus } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: "insensitive" } },
            { email: { contains: q.q, mode: "insensitive" } },
            { phone: { contains: q.q, mode: "insensitive" } },
            ...(Uuid.safeParse(q.q).success ? [{ id: q.q }] : []),
          ],
        }
      : {}),
  };

  const rows = await db.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      roles: true,
      hostVerificationStatus: true,
      deletionRequestedAt: true,
      suspendedAt: true,
      suspendedReason: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    cursor: q.cursor ? { id: q.cursor } : undefined,
    skip: q.cursor ? 1 : undefined,
  });

  const page = rows.slice(0, q.limit);
  return {
    items: page.map((u) =>
      AdminUser.parse({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        roles: u.roles,
        hostVerificationStatus: u.hostVerificationStatus,
        deletionRequestedAt: u.deletionRequestedAt?.toISOString() ?? null,
        suspendedAt: u.suspendedAt?.toISOString() ?? null,
        suspendedReason: u.suspendedReason ?? null,
        createdAt: u.createdAt.toISOString(),
      }),
    ),
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

export async function adminGetUser(id: string) {
  const u = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      roles: true,
      hostVerificationStatus: true,
      deletionRequestedAt: true,
      suspendedAt: true,
      suspendedReason: true,
      createdAt: true,
      vehicles: {
        where: { deletedAt: null },
        select: { id: true, registration: true, type: true, nickname: true },
      },
      bookings: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          status: true,
          rentalType: true,
          startAt: true,
          endAt: true,
          totalPaise: true,
          listing: { select: { id: true, title: true } },
        },
      },
      listings: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          title: true,
          status: true,
          locality: true,
          city: true,
        },
      },
    },
  });

  if (!u) throw new HttpError("not_found", "User not found");

  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    roles: u.roles,
    hostVerificationStatus: u.hostVerificationStatus,
    deletionRequestedAt: u.deletionRequestedAt?.toISOString() ?? null,
    suspendedAt: u.suspendedAt?.toISOString() ?? null,
    suspendedReason: u.suspendedReason ?? null,
    createdAt: u.createdAt.toISOString(),
    vehicles: u.vehicles,
    bookings: u.bookings.map((b) => ({
      id: b.id,
      status: b.status,
      rentalType: b.rentalType,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      total: { paise: b.totalPaise, currency: "INR" as const },
      listing: b.listing,
    })),
    listings: u.listings,
  };
}

export async function adminVerifyHost(
  admin: CurrentUser,
  userId: string,
  decision: "VERIFIED" | "REJECTED",
  reason: string,
) {
  const res = await setHostVerification(admin.id, userId, decision, reason);
  return { ok: true as const, auditLogId: res.auditLogId };
}

export async function adminSuspendUser(
  admin: CurrentUser,
  userId: string,
  suspended: boolean,
  reason: string,
) {
  if (admin.id === userId) {
    throw new HttpError("unprocessable", "An admin cannot suspend themselves");
  }

  const result = await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new HttpError("not_found", "User not found");

    if (suspended) {
      await tx.user.update({
        where: { id: userId },
        data: { suspendedAt: new Date(), suspendedReason: reason },
      });
      await tx.session.deleteMany({ where: { userId } });
      const log = await tx.auditLog.create({
        data: {
          actorId: admin.id,
          action: "user.suspend",
          targetType: "User",
          targetId: userId,
          reason,
        },
      });
      return { auditLogId: log.id };
    } else {
      await tx.user.update({
        where: { id: userId },
        data: { suspendedAt: null, suspendedReason: null },
      });
      const log = await tx.auditLog.create({
        data: {
          actorId: admin.id,
          action: "user.unsuspend",
          targetType: "User",
          targetId: userId,
          reason,
        },
      });
      return { auditLogId: log.id };
    }
  });

  return { ok: true as const, auditLogId: result.auditLogId };
}

// ── Listings ──

const listingInclude = {
  photos: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
  host: { select: { id: true, name: true, hostVerificationStatus: true } },
} satisfies Prisma.ListingInclude;

export async function adminListListings(
  q: AdminListListingsQuery,
): Promise<AdminListListingsResponse> {
  validateCursor(q.cursor);
  const where: Prisma.ListingWhereInput = {
    ...(q.listingStatus ? { status: q.listingStatus } : {}),
    ...(q.hostId ? { hostId: q.hostId } : {}),
    ...(q.q
      ? {
          OR: [
            { title: { contains: q.q, mode: "insensitive" } },
            { description: { contains: q.q, mode: "insensitive" } },
            { address: { contains: q.q, mode: "insensitive" } },
            { locality: { contains: q.q, mode: "insensitive" } },
            ...(Uuid.safeParse(q.q).success ? [{ id: q.q }] : []),
          ],
        }
      : {}),
  };

  const rows = await db.listing.findMany({
    where,
    include: listingInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    cursor: q.cursor ? { id: q.cursor } : undefined,
    skip: q.cursor ? 1 : undefined,
  });

  const page = rows.slice(0, q.limit);
  const ratings = await db.review.groupBy({
    by: ["listingId"],
    where: { listingId: { in: page.map((l) => l.id) }, moderationStatus: "APPROVED" },
    _avg: { rating: true },
    _count: true,
  });
  const byId = new Map(
    ratings.map((r) => [r.listingId, { average: r._avg.rating, count: r._count }]),
  );
  const policy = await getActivePolicy();

  const items: AdminListing[] = page.map((l) => ({
    ...toOwned(l, policy, byId.get(l.id) ?? { average: null, count: 0 }),
    hostId: l.hostId,
  }));

  return {
    items,
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

export async function adminSuspendListing(
  admin: CurrentUser,
  listingId: string,
  suspended: boolean,
  reason: string,
) {
  if (suspended) {
    const res = await suspendListing(admin.id, listingId, reason);
    return { ok: true as const, auditLogId: res.auditLogId };
  }

  const listing = await db.listing.findUnique({ where: { id: listingId } });
  if (!listing) throw new HttpError("not_found", "Listing not found");

  const [, log] = await db.$transaction([
    db.listing.update({
      where: { id: listingId },
      data: { status: "PUBLISHED", suspendedReason: null },
    }),
    audit(admin.id, "listing.unsuspend", "Listing", listingId, reason),
  ]);

  return { ok: true as const, auditLogId: log.id };
}

// ── Bookings ──

export async function adminListBookings(
  admin: CurrentUser,
  q: AdminListBookingsQuery,
): Promise<AdminListBookingsResponse> {
  validateCursor(q.cursor);
  const where: Prisma.BookingWhereInput = {
    ...(q.bookingStatus ? { status: q.bookingStatus } : {}),
    ...(q.listingId ? { listingId: q.listingId } : {}),
    ...(q.renterId ? { renterId: q.renterId } : {}),
    ...(q.q
      ? {
          OR: [
            ...(Uuid.safeParse(q.q).success ? [{ id: q.q }] : []),
            { listing: { title: { contains: q.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const rows = await db.booking.findMany({
    where,
    select: { id: true, listing: { select: { hostId: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    cursor: q.cursor ? { id: q.cursor } : undefined,
    skip: q.cursor ? 1 : undefined,
  });

  const page = rows.slice(0, q.limit);
  const items: AdminBooking[] = await Promise.all(
    page.map(async (r) => ({
      ...(await getBooking(r.id, admin)),
      hostId: r.listing.hostId,
    })),
  );

  return {
    items,
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

export async function adminGetBookingDetail(id: string, admin: CurrentUser) {
  const booking = await getBooking(id, admin);
  const hostRecord = await db.booking.findUnique({
    where: { id },
    select: { listing: { select: { hostId: true } } },
  });
  if (!hostRecord) throw new HttpError("not_found", "Booking not found");

  const [payments, ledgerEntries, sessionEvents, incidents, notifications, disputes] =
    await Promise.all([
      db.payment.findMany({
        where: { bookingId: id },
        include: { refunds: { orderBy: { createdAt: "asc" } } },
        orderBy: { createdAt: "asc" },
      }),
      db.ledgerEntry.findMany({
        where: { bookingId: id },
        orderBy: { createdAt: "asc" },
      }),
      db.sessionEvent.findMany({
        where: { bookingId: id },
        orderBy: { createdAt: "asc" },
      }),
      db.overstayIncident.findMany({
        where: { bookingId: id },
        orderBy: { createdAt: "asc" },
      }),
      db.notification.findMany({
        where: { payload: { path: ["bookingId"], equals: id } },
        orderBy: { createdAt: "asc" },
      }),
      db.dispute.findMany({
        where: { bookingId: id },
        select: { id: true },
      }),
    ]);

  const linkedIds = [
    id,
    ...disputes.map((d) => d.id),
    ...payments.flatMap((p) => [p.id, ...p.refunds.map((r) => r.id)]),
  ];

  const auditLog = await db.auditLog.findMany({
    where: { targetId: { in: linkedIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const iso = (d: Date | null) => d?.toISOString() ?? null;

  return {
    booking: {
      ...booking,
      hostId: hostRecord.listing.hostId,
    },
    payments: payments.map((p) => ({
      id: p.id,
      bookingId: p.bookingId,
      provider: p.provider,
      providerOrderId: p.providerOrderId,
      providerPaymentId: p.providerPaymentId,
      amount: { paise: p.amountPaise, currency: "INR" as const },
      status: p.status,
      failureReason: p.failureReason,
      signatureVerifiedAt: iso(p.signatureVerifiedAt),
      reconciledAt: iso(p.reconciledAt),
      refunds: p.refunds.map((r) => ({
        id: r.id,
        amount: { paise: r.amountPaise, currency: "INR" as const },
        reason: r.reason,
        providerRefundId: r.providerRefundId,
        status: r.status,
        failureReason: r.failureReason,
        reconciledAt: iso(r.reconciledAt),
        createdAt: r.createdAt.toISOString(),
      })),
      createdAt: p.createdAt.toISOString(),
    })),
    ledger: ledgerEntries.map((l) => ({
      id: l.id,
      account: l.account,
      amount: { paise: l.amountPaise, currency: "INR" as const },
      reference: l.reference,
      memo: l.memo,
      createdAt: l.createdAt.toISOString(),
    })),
    sessionEvents: sessionEvents.map((s) => ({
      id: s.id,
      type: s.type,
      actorId: s.actorId,
      occurredAt: s.occurredAt.toISOString(),
      metadata: s.metadata,
      createdAt: s.createdAt.toISOString(),
    })),
    incidents: incidents.map((i) => ({
      id: i.id,
      status: i.status,
      evidenceUrls: i.evidenceUrls,
      resolution: i.resolution,
      resolvedAt: iso(i.resolvedAt),
      createdAt: i.createdAt.toISOString(),
    })),
    notifications: notifications.map((n) => ({
      id: n.id,
      userId: n.userId,
      channel: n.channel,
      type: n.type,
      status: n.status,
      scheduledAt: n.scheduledAt.toISOString(),
      sentAt: iso(n.sentAt),
    })),
    auditLog: auditLog.map((a) => ({
      id: a.id,
      actorId: a.actorId,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

// ── Payments ──

type PaymentWithRefunds = Prisma.PaymentGetPayload<{
  include: { refunds: { orderBy: { createdAt: "asc" } } };
}>;

export async function adminListPayments(
  q: AdminListPaymentsQuery,
): Promise<AdminListPaymentsResponse> {
  validateCursor(q.cursor);
  const where: Prisma.PaymentWhereInput = {
    ...(q.paymentStatus ? { status: q.paymentStatus } : {}),
    ...(q.bookingId ? { bookingId: q.bookingId } : {}),
    ...(q.unreconciled ? { reconciledAt: null } : {}),
    ...(q.q
      ? {
          OR: [
            { providerOrderId: { contains: q.q, mode: "insensitive" } },
            { providerPaymentId: { contains: q.q, mode: "insensitive" } },
            ...(Uuid.safeParse(q.q).success ? [{ id: q.q }, { bookingId: q.q }] : []),
          ],
        }
      : {}),
  };

  const rows: PaymentWithRefunds[] = await db.payment.findMany({
    where,
    include: {
      refunds: { orderBy: { createdAt: "asc" } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    cursor: q.cursor ? { id: q.cursor } : undefined,
    skip: q.cursor ? 1 : undefined,
  });

  const page = rows.slice(0, q.limit);
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  const items: AdminPayment[] = page.map((p) => ({
    id: p.id,
    bookingId: p.bookingId,
    provider: p.provider,
    providerOrderId: p.providerOrderId,
    providerPaymentId: p.providerPaymentId,
    amount: { paise: p.amountPaise, currency: "INR" as const },
    status: p.status,
    failureReason: p.failureReason,
    signatureVerifiedAt: iso(p.signatureVerifiedAt),
    reconciledAt: iso(p.reconciledAt),
    refunds: p.refunds.map((r): AdminRefund => ({
      id: r.id,
      amount: { paise: r.amountPaise, currency: "INR" as const },
      reason: r.reason,
      providerRefundId: r.providerRefundId,
      status: r.status,
      failureReason: r.failureReason,
      reconciledAt: iso(r.reconciledAt),
      createdAt: r.createdAt.toISOString(),
    })),
    createdAt: p.createdAt.toISOString(),
  }));

  return {
    items,
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

// ── Jobs ──

export async function adminListJobs(q: AdminListJobsQuery): Promise<AdminListJobsResponse> {
  validateCursor(q.cursor);
  const where: Prisma.JobWhereInput = {
    ...(q.jobStatus ? { status: q.jobStatus } : {}),
    ...(q.type ? { type: q.type } : {}),
  };

  const rows = await db.job.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    cursor: q.cursor ? { id: q.cursor } : undefined,
    skip: q.cursor ? 1 : undefined,
  });

  const page = rows.slice(0, q.limit);
  const items: AdminJob[] = page.map((j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    runAt: j.runAt.toISOString(),
    lastError: j.lastError,
    createdAt: j.createdAt.toISOString(),
  }));

  return {
    items,
    nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

// ── Notifications (read-only for ops) ──

export async function adminListNotifications(q: {
  status?: string;
  limit?: number;
  cursor?: string;
}) {
  validateCursor(q.cursor);
  const limit = Math.min(q.limit ?? 25, 100);
  const where: Prisma.NotificationWhereInput = {
    ...(q.status ? { status: q.status as any } : {}),
  };

  const rows = await db.notification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    cursor: q.cursor ? { id: q.cursor } : undefined,
    skip: q.cursor ? 1 : undefined,
  });

  const page = rows.slice(0, limit);
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  return {
    items: page.map((n) => ({
      id: n.id,
      userId: n.userId,
      channel: n.channel,
      type: n.type,
      status: n.status,
      scheduledAt: n.scheduledAt.toISOString(),
      sentAt: iso(n.sentAt),
      createdAt: n.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}
