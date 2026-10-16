import type { CurrentUser } from "@/server/auth/guards";
import type { CreateReportBody } from "@/contracts/reports";
import { ReportReason, type ReportStatus, type ReportTargetType } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { audit } from "@/server/http/audit";
import { HttpError } from "@/server/http/errors";
import { suspendListing } from "@/server/listings/service";
import { isOurReportEvidenceUrl } from "@/server/media/evidence";

export function toReportReason(category?: string, reason?: string): ReportReason {
  if (reason && Object.values(ReportReason).includes(reason as ReportReason)) {
    return reason as ReportReason;
  }
  switch (category) {
    case "ACCESS_PROBLEM":
      return ReportReason.ACCESS_PROBLEM;
    case "SUSPICIOUS":
      return ReportReason.SUSPICIOUS_BEHAVIOR;
    case "INACCURATE_LISTING":
      return ReportReason.INACCURATE_LISTING;
    case "INAPPROPRIATE":
      return ReportReason.INAPPROPRIATE_CONTENT;
    case "OTHER":
      return ReportReason.OTHER;
    default:
      if (reason && reason in ReportReason) {
        return ReportReason[reason as keyof typeof ReportReason];
      }
      return ReportReason.OTHER;
  }
}

export async function createReport(user: CurrentUser, body: CreateReportBody) {
  const {
    targetType,
    targetId,
    category,
    reason: explicitReason,
    description,
    evidenceUrls,
  } = body;

  if (!category && !explicitReason) {
    throw new HttpError("validation_error", "Either category or reason is required");
  }

  // 1. Evidence URLs validation: only our Cloudinary listing/evidence folders
  const urls = evidenceUrls ?? [];
  for (const url of urls) {
    if (!isOurReportEvidenceUrl(url)) {
      throw new HttpError(
        "validation_error",
        "Evidence URLs must be from Cloudinary listing or evidence folders",
      );
    }
  }

  // 2. Validate target exists and is visible to the reporter
  switch (targetType) {
    case "LISTING": {
      const listing = await db.listing.findUnique({
        where: { id: targetId },
        select: { id: true, hostId: true, status: true },
      });
      if (!listing) {
        throw new HttpError("not_found", "Listing not found");
      }
      if (listing.status === "DRAFT" && listing.hostId !== user.id) {
        throw new HttpError("not_found", "Listing not found");
      }
      break;
    }
    case "REVIEW": {
      const review = await db.review.findUnique({
        where: { id: targetId },
        select: { id: true, authorId: true, moderationStatus: true },
      });
      if (!review) {
        throw new HttpError("not_found", "Review not found");
      }
      if (review.moderationStatus !== "APPROVED" && review.authorId !== user.id) {
        throw new HttpError("not_found", "Review not found");
      }
      break;
    }
    case "USER": {
      const targetUser = await db.user.findUnique({
        where: { id: targetId },
        select: { id: true },
      });
      if (!targetUser) {
        throw new HttpError("not_found", "User not found");
      }
      break;
    }
    case "BOOKING": {
      // No probing of private bookings: BOOKING targets only for the reporter's own bookings as renter or host
      const booking = await db.booking.findUnique({
        where: { id: targetId },
        include: { listing: { select: { hostId: true } } },
      });
      if (!booking) {
        throw new HttpError("not_found", "Booking not found");
      }
      if (booking.renterId !== user.id && booking.listing.hostId !== user.id) {
        throw new HttpError("not_found", "Booking not found");
      }
      break;
    }
    default:
      throw new HttpError("validation_error", "Invalid target type");
  }

  const reason = toReportReason(category, explicitReason);

  const report = await db.report.create({
    data: {
      reporterId: user.id,
      targetType,
      targetId,
      reason,
      description,
      evidenceUrls: urls,
      status: "OPEN",
    },
  });

  return {
    id: report.id,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
  };
}

export async function listReports(
  _adminUser: CurrentUser,
  filters: {
    status?: ReportStatus;
    targetType?: ReportTargetType;
    limit?: number;
    cursor?: string;
  },
) {
  const limit = filters.limit ?? 20;
  const where: { status?: ReportStatus; targetType?: ReportTargetType } = {};
  if (filters.status) where.status = filters.status;
  if (filters.targetType) where.targetType = filters.targetType;

  const reports = await db.report.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
  });

  const hasMore = reports.length > limit;
  const items = hasMore ? reports.slice(0, limit) : reports;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return {
    items: items.map((r) => ({
      id: r.id,
      reporterId: r.reporterId,
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      description: r.description,
      evidenceUrls: r.evidenceUrls,
      status: r.status,
      resolution: r.resolution,
      resolvedById: r.resolvedById,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function resolveReport(
  adminUser: CurrentUser,
  reportId: string,
  body: { action: "DISMISS" | "ACTION"; resolution: string; reason: string },
) {
  const report = await db.report.findUnique({
    where: { id: reportId },
  });
  if (!report) {
    throw new HttpError("not_found", "Report not found");
  }

  const newStatus: ReportStatus = body.action === "DISMISS" ? "DISMISSED" : "ACTIONED";

  // For LISTING targets with ACTION, call suspendListing from src/server/listings
  if (report.targetType === "LISTING" && body.action === "ACTION") {
    await suspendListing(adminUser.id, report.targetId, body.reason);
  }

  const [, auditLog] = await db.$transaction([
    db.report.update({
      where: { id: reportId },
      data: {
        status: newStatus,
        resolution: body.resolution,
        resolvedById: adminUser.id,
        resolvedAt: new Date(),
      },
    }),
    audit(
      adminUser.id,
      body.action === "DISMISS" ? "report.dismiss" : "report.action",
      "Report",
      reportId,
      body.reason,
      {
        action: body.action,
        resolution: body.resolution,
        targetType: report.targetType,
        targetId: report.targetId,
      },
    ),
  ]);

  return { ok: true as const, auditLogId: auditLog.id };
}
