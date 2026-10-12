import type { CurrentUser } from "@/server/auth/guards";
import type { CreateReviewBody } from "@/contracts/reviews";
import { db } from "@/server/db";
import { audit } from "@/server/http/audit";
import { HttpError } from "@/server/http/errors";

export async function createReview(user: CurrentUser, body: CreateReviewBody) {
  const { bookingId, rating, comment } = body;

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, renterId: true, listingId: true, status: true },
  });

  if (!booking) {
    throw new HttpError("not_found", "Booking not found");
  }

  if (booking.renterId !== user.id) {
    throw new HttpError("forbidden", "Only the renter may review this booking");
  }

  if (booking.status !== "COMPLETED") {
    throw new HttpError("forbidden", "Only completed bookings can be reviewed");
  }

  const existing = await db.review.findFirst({
    where: { bookingId },
  });
  if (existing) {
    throw new HttpError("conflict", "This booking has already been reviewed");
  }

  if (rating < 1 || rating > 5) {
    throw new HttpError("validation_error", "Rating must be between 1 and 5");
  }

  const trimmedComment = comment?.trim();
  const hasComment = Boolean(trimmedComment && trimmedComment.length > 0);
  const moderationStatus = hasComment ? "PENDING" : "APPROVED";

  const review = await db.review.create({
    data: {
      bookingId,
      listingId: booking.listingId,
      authorId: user.id,
      rating,
      comment: hasComment ? trimmedComment : null,
      moderationStatus,
    },
  });

  return {
    id: review.id,
    bookingId: review.bookingId,
    listingId: review.listingId,
    rating: review.rating,
    comment: review.comment,
    moderationStatus: review.moderationStatus,
    createdAt: review.createdAt.toISOString(),
  };
}

export async function listingRatingSummary(listingIds: string[]) {
  const map = new Map<string, { average: number | null; count: number }>();
  for (const id of listingIds) {
    map.set(id, { average: null, count: 0 });
  }
  if (listingIds.length === 0) return map;

  const rows = await db.review.groupBy({
    by: ["listingId"],
    where: {
      listingId: { in: listingIds },
      moderationStatus: "APPROVED",
    },
    _avg: { rating: true },
    _count: true,
  });

  for (const r of rows) {
    map.set(r.listingId, {
      average: r._avg.rating !== null ? Math.round(Number(r._avg.rating) * 10) / 10 : null,
      count: r._count,
    });
  }

  return map;
}

export async function listListingReviews(listingId: string, limit = 20, cursor?: string) {
  const listing = await db.listing.findUnique({
    where: { id: listingId },
    select: { id: true, status: true },
  });
  if (!listing || listing.status === "DRAFT") {
    throw new HttpError("not_found", "Listing not found");
  }

  const reviews = await db.review.findMany({
    where: {
      listingId,
      moderationStatus: "APPROVED",
    },
    include: {
      author: {
        select: {
          name: true,
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = reviews.length > limit;
  const items = hasMore ? reviews.slice(0, limit) : reviews;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  const summaryMap = await listingRatingSummary([listingId]);
  const summary = summaryMap.get(listingId) ?? { average: null, count: 0 };

  return {
    items: items.map((r) => {
      const firstName = r.author.name?.trim().split(/\s+/)[0] ?? null;
      return {
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
        reviewerFirstName: firstName,
      };
    }),
    nextCursor,
    rating: summary,
    summary,
  };
}

export async function moderateReview(
  adminUser: CurrentUser,
  reviewId: string,
  decision: "APPROVED" | "REJECTED",
  reason: string,
) {
  const review = await db.review.findUnique({
    where: { id: reviewId },
  });
  if (!review) {
    throw new HttpError("not_found", "Review not found");
  }

  const [, auditLog] = await db.$transaction([
    db.review.update({
      where: { id: reviewId },
      data: { moderationStatus: decision },
    }),
    audit(adminUser.id, "review.moderate", "Review", reviewId, reason, {
      previousStatus: review.moderationStatus,
      decision,
    }),
  ]);

  return { ok: true as const, auditLogId: auditLog.id };
}
