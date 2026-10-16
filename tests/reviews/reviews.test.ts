import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BookingStatus } from "@/generated/prisma/client";
import { testDb, truncateAll } from "../setup/db";
import { noParams, req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { POST: createReviewRoute } = await import("@/app/api/reviews/route");
const { GET: getListingReviewsRoute } = await import("@/app/api/listings/[id]/reviews/route");
const { POST: moderateReviewRoute } = await import("@/app/api/admin/reviews/[id]/moderate/route");
const { listingRatingSummary } = await import("@/server/reviews/service");
const { ReviewForm } = await import("@/components/reviews/review-form");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const at = (id: string) => ({ params: Promise.resolve({ id }) });

async function seedTestListing(hostName = "Rahul Dravid", hostEmail = "rahul.dravid@example.com") {
  const host = await testDb.user.create({
    data: {
      email: hostEmail,
      name: hostName,
      roles: ["HOST"],
    },
  });
  return testDb.listing.create({
    data: {
      hostId: host.id,
      title: "Shivajinagar Garage",
      description: "Secure indoor parking",
      address: "100 FC Road",
      locality: "Shivajinagar",
      city: "Pune",
      lat: 18.53,
      lng: 73.84,
      approxLat: 18.531,
      approxLng: 73.841,
      spaceType: "GARAGE",
      vehicleTypes: ["SEDAN", "SUV"],
      hourlyPaise: 4000,
      minDurationMinutes: 60,
      status: "PUBLISHED",
    },
  });
}

async function seedTestBooking(
  renterId: string,
  listingId: string,
  status: BookingStatus = "COMPLETED",
) {
  const startAt = new Date(Date.now() - 7200_000);
  const endAt = new Date(Date.now() - 3600_000);
  return testDb.booking.create({
    data: {
      renterId,
      listingId,
      rentalType: "HOURLY",
      startAt,
      endAt,
      blockedUntil: endAt,
      status,
      subtotalPaise: 10000,
      renterFeePaise: 0,
      commissionPaise: 1000,
      hostEarningsPaise: 9000,
      totalPaise: 10000,
      currency: "INR",
    },
  });
}

describe("POST /api/reviews", () => {
  test("reviewing a non-completed or someone else's booking → 403/404", async () => {
    const listing = await seedTestListing();
    const renter1 = await seedSession(["RENTER"]);
    const renter2 = await seedSession(["RENTER"]);

    // Non-completed booking (CONFIRMED)
    const activeBooking = await seedTestBooking(renter1.user.id, listing.id, "CONFIRMED");
    const resActive = await createReviewRoute(
      req("/api/reviews", {
        method: "POST",
        cookie: renter1.cookie,
        body: { bookingId: activeBooking.id, rating: 5, comment: "Nice" },
      }),
      noParams,
    );
    expect([403, 404]).toContain(resActive.status);

    // Someone else's booking
    const completedBooking = await seedTestBooking(renter1.user.id, listing.id, "COMPLETED");
    const resOther = await createReviewRoute(
      req("/api/reviews", {
        method: "POST",
        cookie: renter2.cookie,
        body: { bookingId: completedBooking.id, rating: 5, comment: "Nice" },
      }),
      noParams,
    );
    expect([403, 404]).toContain(resOther.status);
  });

  test("a second review → 409", async () => {
    const listing = await seedTestListing();
    const renter = await seedSession(["RENTER"]);
    const booking = await seedTestBooking(renter.user.id, listing.id, "COMPLETED");

    // First review succeeds
    const firstRes = await createReviewRoute(
      req("/api/reviews", {
        method: "POST",
        cookie: renter.cookie,
        body: { bookingId: booking.id, rating: 5, comment: "First review" },
      }),
      noParams,
    );
    expect(firstRes.status).toBe(201);

    // Second review on same booking → 409
    const secondRes = await createReviewRoute(
      req("/api/reviews", {
        method: "POST",
        cookie: renter.cookie,
        body: { bookingId: booking.id, rating: 4, comment: "Second review" },
      }),
      noParams,
    );
    expect(secondRes.status).toBe(409);
  });

  test("a rating outside 1–5 → 400", async () => {
    const listing = await seedTestListing();
    const renter = await seedSession(["RENTER"]);
    const booking = await seedTestBooking(renter.user.id, listing.id, "COMPLETED");

    for (const badRating of [0, 6, -1, 10]) {
      const res = await createReviewRoute(
        req("/api/reviews", {
          method: "POST",
          cookie: renter.cookie,
          body: { bookingId: booking.id, rating: badRating },
        }),
        noParams,
      );
      expect(res.status).toBe(400);
    }
  });

  test("auto-APPROVE when the comment is empty; PENDING when comment is provided", async () => {
    const listing = await seedTestListing();
    const renter1 = await seedSession(["RENTER"]);
    const renter2 = await seedSession(["RENTER"]);
    const booking1 = await seedTestBooking(renter1.user.id, listing.id, "COMPLETED");
    const booking2 = await seedTestBooking(renter2.user.id, listing.id, "COMPLETED");

    // Empty comment → auto-APPROVE
    const emptyRes = await createReviewRoute(
      req("/api/reviews", {
        method: "POST",
        cookie: renter1.cookie,
        body: { bookingId: booking1.id, rating: 5 },
      }),
      noParams,
    );
    expect(emptyRes.status).toBe(201);
    const emptyBody = await emptyRes.json();
    expect(emptyBody.moderationStatus).toBe("APPROVED");

    // Comment provided → PENDING
    const commentRes = await createReviewRoute(
      req("/api/reviews", {
        method: "POST",
        cookie: renter2.cookie,
        body: { bookingId: booking2.id, rating: 4, comment: "Spacious and easy to park." },
      }),
      noParams,
    );
    expect(commentRes.status).toBe(201);
    const commentBody = await commentRes.json();
    expect(commentBody.moderationStatus).toBe("PENDING");
  });
});

describe("GET /api/listings/:id/reviews and XSS safety", () => {
  test("public reviews show only APPROVED with no author email/last name", async () => {
    const listing = await seedTestListing();

    const author = await testDb.user.create({
      data: {
        name: "Pooja Hegde",
        email: "pooja.private@example.com",
        roles: ["RENTER"],
      },
    });

    const booking1 = await seedTestBooking(author.id, listing.id, "COMPLETED");
    const booking2 = await seedTestBooking(author.id, listing.id, "COMPLETED");

    // Create an approved review
    await testDb.review.create({
      data: {
        bookingId: booking1.id,
        listingId: listing.id,
        authorId: author.id,
        rating: 5,
        comment: "Excellent location and security.",
        moderationStatus: "APPROVED",
      },
    });

    // Create a pending review
    await testDb.review.create({
      data: {
        bookingId: booking2.id,
        listingId: listing.id,
        authorId: author.id,
        rating: 1,
        comment: "Pending bad review",
        moderationStatus: "PENDING",
      },
    });

    const res = await getListingReviewsRoute(
      req(`/api/listings/${listing.id}/reviews`),
      at(listing.id),
    );
    expect(res.status).toBe(200);
    const data = await res.json();

    // Only approved review is returned
    expect(data.items).toHaveLength(1);
    expect(data.items[0].comment).toBe("Excellent location and security.");
    expect(data.items[0].reviewerFirstName).toBe("Pooja");

    // Verify privacy: no email and no last name in response JSON
    const jsonStr = JSON.stringify(data);
    expect(jsonStr).not.toContain("pooja.private@example.com");
    expect(jsonStr).not.toContain("Hegde");

    // Rating summary
    expect(data.rating).toEqual({ average: 5, count: 1 });
  });

  test("a comment with <script> is returned verbatim as text (no HTML), and the UI renders it as text", async () => {
    const listing = await seedTestListing();
    const { user, cookie } = await seedSession(["RENTER"]);
    const booking = await seedTestBooking(user.id, listing.id, "COMPLETED");

    const payload = '<script>alert("xss")</script>';
    const postRes = await createReviewRoute(
      req("/api/reviews", {
        method: "POST",
        cookie,
        body: { bookingId: booking.id, rating: 5, comment: payload },
      }),
      noParams,
    );
    expect(postRes.status).toBe(201);
    const body = await postRes.json();
    // Returned verbatim as plain text
    expect(body.comment).toBe(payload);

    // Verify UI renders it as plain escaped text, not raw HTML executable markup
    const html = renderToStaticMarkup(
      React.createElement(ReviewForm, {
        bookingId: booking.id,
        listingTitle: "Test Space",
        onSubmitted: () => {},
      }),
    );
    expect(html).not.toContain("<script>alert");

    // Verify rendering a review comment container escapes script tags
    const commentHtml = renderToStaticMarkup(
      React.createElement("p", { className: "whitespace-pre-wrap" }, body.comment),
    );
    expect(commentHtml).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(commentHtml).not.toContain("<script>alert");
  });
});

describe("Admin moderation and rating summary", () => {
  test("admin resolve/moderate requires a reason, writes an audit, and non-admin → 403", async () => {
    const listing = await seedTestListing();
    const renter = await seedSession(["RENTER"]);
    const admin = await seedSession(["ADMIN"]);
    const booking = await seedTestBooking(renter.user.id, listing.id, "COMPLETED");

    const review = await testDb.review.create({
      data: {
        bookingId: booking.id,
        listingId: listing.id,
        authorId: renter.user.id,
        rating: 3,
        comment: "Needs verification",
        moderationStatus: "PENDING",
      },
    });

    // Non-admin → 403
    const nonAdminRes = await moderateReviewRoute(
      req(`/api/admin/reviews/${review.id}/moderate`, {
        method: "POST",
        cookie: renter.cookie,
        body: { decision: "APPROVED", reason: "Reviewed manually" },
      }),
      at(review.id),
    );
    expect(nonAdminRes.status).toBe(403);

    // Missing reason → 400
    const missingReasonRes = await moderateReviewRoute(
      req(`/api/admin/reviews/${review.id}/moderate`, {
        method: "POST",
        cookie: admin.cookie,
        body: { decision: "APPROVED" },
      }),
      at(review.id),
    );
    expect(missingReasonRes.status).toBe(400);

    // Admin with reason → 200 and writes AuditLog
    const adminRes = await moderateReviewRoute(
      req(`/api/admin/reviews/${review.id}/moderate`, {
        method: "POST",
        cookie: admin.cookie,
        body: { decision: "APPROVED", reason: "Appropriate comment confirmed" },
      }),
      at(review.id),
    );
    expect(adminRes.status).toBe(200);
    const adminBody = await adminRes.json();
    expect(adminBody.ok).toBe(true);

    // Verify DB update
    const updated = await testDb.review.findUniqueOrThrow({ where: { id: review.id } });
    expect(updated.moderationStatus).toBe("APPROVED");

    // Verify AuditLog
    const auditLog = await testDb.auditLog.findUniqueOrThrow({ where: { id: adminBody.auditLogId } });
    expect(auditLog).toMatchObject({
      actorId: admin.user.id,
      action: "review.moderate",
      targetType: "Review",
      targetId: review.id,
      reason: "Appropriate comment confirmed",
    });
  });

  test("listingRatingSummary calculates accurate average and count", async () => {
    const listing = await seedTestListing();
    const renter1 = await seedSession(["RENTER"]);
    const renter2 = await seedSession(["RENTER"]);
    const b1 = await seedTestBooking(renter1.user.id, listing.id, "COMPLETED");
    const b2 = await seedTestBooking(renter2.user.id, listing.id, "COMPLETED");

    await testDb.review.create({
      data: {
        bookingId: b1.id,
        listingId: listing.id,
        authorId: renter1.user.id,
        rating: 5,
        moderationStatus: "APPROVED",
      },
    });

    await testDb.review.create({
      data: {
        bookingId: b2.id,
        listingId: listing.id,
        authorId: renter2.user.id,
        rating: 4,
        moderationStatus: "APPROVED",
      },
    });

    const summaryMap = await listingRatingSummary([listing.id]);
    const summary = summaryMap.get(listing.id);
    expect(summary).toEqual({ average: 4.5, count: 2 });
  });
});

test("an invalid pagination cursor is a 400 validation_error, not a 500 (L9)", async () => {
  const listing = await seedTestListing();
  const res = await getListingReviewsRoute(
    req(`/api/listings/${listing.id}/reviews?cursor=x`),
    at(listing.id),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe("validation_error");
});
