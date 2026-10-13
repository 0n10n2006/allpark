import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";
import { noParams, req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { GET: getUsers } = await import("@/app/api/admin/users/route");
const { POST: verifyHost } = await import("@/app/api/admin/users/[id]/verify-host/route");
const { POST: suspendUser } = await import("@/app/api/admin/users/[id]/suspend/route");
const { GET: getListings } = await import("@/app/api/admin/listings/route");
const { POST: suspendListing } = await import("@/app/api/admin/listings/[id]/suspend/route");
const { GET: getBookings } = await import("@/app/api/admin/bookings/route");
const { GET: getPayments } = await import("@/app/api/admin/payments/route");
const { GET: getJobs } = await import("@/app/api/admin/jobs/route");
const { GET: getReviews } = await import("@/app/api/admin/reviews/route");
const { GET: getStats } = await import("@/app/api/admin/stats/route");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const at = (id: string) => ({ params: Promise.resolve({ id }) });

describe("Admin APIs (T4.6 / FR-13)", () => {
  test("non-admin gets 403 on all admin routes", async () => {
    const renter = await seedSession(["RENTER", "HOST"]);
    const targetId = "11111111-1111-1111-1111-111111111111";

    const resUsers = await getUsers(req("/api/admin/users", { cookie: renter.cookie }), noParams);
    expect(resUsers.status).toBe(403);

    const resStats = await getStats(req("/api/admin/stats", { cookie: renter.cookie }), noParams);
    expect(resStats.status).toBe(403);

    const resListings = await getListings(
      req("/api/admin/listings", { cookie: renter.cookie }),
      noParams,
    );
    expect(resListings.status).toBe(403);

    const resBookings = await getBookings(
      req("/api/admin/bookings", { cookie: renter.cookie }),
      noParams,
    );
    expect(resBookings.status).toBe(403);

    const resPayments = await getPayments(
      req("/api/admin/payments", { cookie: renter.cookie }),
      noParams,
    );
    expect(resPayments.status).toBe(403);

    const resJobs = await getJobs(req("/api/admin/jobs", { cookie: renter.cookie }), noParams);
    expect(resJobs.status).toBe(403);

    const resReviews = await getReviews(
      req("/api/admin/reviews", { cookie: renter.cookie }),
      noParams,
    );
    expect(resReviews.status).toBe(403);

    const resVerify = await verifyHost(
      req(`/api/admin/users/${targetId}/verify-host`, {
        method: "POST",
        cookie: renter.cookie,
        body: { decision: "VERIFIED", reason: "All documents valid" },
      }),
      at(targetId),
    );
    expect(resVerify.status).toBe(403);

    const resSuspend = await suspendUser(
      req(`/api/admin/users/${targetId}/suspend`, {
        method: "POST",
        cookie: renter.cookie,
        body: { suspended: true, reason: "Violation" },
      }),
      at(targetId),
    );
    expect(resSuspend.status).toBe(403);
  });

  test("dashboard stats returns open counts", async () => {
    const admin = await seedSession(["ADMIN"]);
    const res = await getStats(req("/api/admin/stats", { cookie: admin.cookie }), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      openDisputesCount: 0,
      openReportsCount: 0,
      pendingHostVerificationsCount: 0,
      pendingPayoutsCount: 0,
      deadJobsCount: 0,
      failedNotificationsCount: 0,
    });
  });

  test("host verification: approve writes audit log with reason and grants HOST role", async () => {
    const admin = await seedSession(["ADMIN"]);
    const applicant = await testDb.user.create({
      data: {
        email: "applicant@example.com",
        name: "Host Applicant",
        roles: ["RENTER"],
        hostVerificationStatus: "PENDING",
      },
    });

    const res = await verifyHost(
      req(`/api/admin/users/${applicant.id}/verify-host`, {
        method: "POST",
        cookie: admin.cookie,
        body: { decision: "VERIFIED", reason: "Verified identity document" },
      }),
      at(applicant.id),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.auditLogId).toBeDefined();

    const updated = await testDb.user.findUniqueOrThrow({ where: { id: applicant.id } });
    expect(updated.hostVerificationStatus).toBe("VERIFIED");
    expect(updated.roles).toContain("HOST");

    const audit = await testDb.auditLog.findUniqueOrThrow({ where: { id: body.auditLogId } });
    expect(audit.actorId).toBe(admin.user.id);
    expect(audit.action).toBe("host.verification");
    expect(audit.targetType).toBe("User");
    expect(audit.targetId).toBe(applicant.id);
    expect(audit.reason).toBe("Verified identity document");
  });

  test("user suspend: sets suspendedAt/reason, deletes active sessions, audits action", async () => {
    const admin = await seedSession(["ADMIN"]);
    const target = await seedSession(["RENTER"]);

    // Ensure session exists
    const sessionCountBefore = await testDb.session.count({ where: { userId: target.user.id } });
    expect(sessionCountBefore).toBeGreaterThan(0);

    const res = await suspendUser(
      req(`/api/admin/users/${target.user.id}/suspend`, {
        method: "POST",
        cookie: admin.cookie,
        body: { suspended: true, reason: "Repeated safety violations" },
      }),
      at(target.user.id),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // User is marked suspended
    const userAfter = await testDb.user.findUniqueOrThrow({ where: { id: target.user.id } });
    expect(userAfter.suspendedAt).not.toBeNull();
    expect(userAfter.suspendedReason).toBe("Repeated safety violations");

    // All sessions deleted immediately
    const sessionCountAfter = await testDb.session.count({ where: { userId: target.user.id } });
    expect(sessionCountAfter).toBe(0);

    // AuditLog row created
    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { targetId: target.user.id, action: "user.suspend" },
    });
    expect(audit.actorId).toBe(admin.user.id);
    expect(audit.reason).toBe("Repeated safety violations");

    // Unsuspend
    const resUnsuspend = await suspendUser(
      req(`/api/admin/users/${target.user.id}/suspend`, {
        method: "POST",
        cookie: admin.cookie,
        body: { suspended: false, reason: "Account reinstated after appeal" },
      }),
      at(target.user.id),
    );
    expect(resUnsuspend.status).toBe(200);
    const userUnsus = await testDb.user.findUniqueOrThrow({ where: { id: target.user.id } });
    expect(userUnsus.suspendedAt).toBeNull();
    expect(userUnsus.suspendedReason).toBeNull();

    const auditUnsus = await testDb.auditLog.findFirstOrThrow({
      where: { targetId: target.user.id, action: "user.unsuspend" },
    });
    expect(auditUnsus.reason).toBe("Account reinstated after appeal");
  });

  test("admin cannot suspend themselves → 422 unprocessable", async () => {
    const admin = await seedSession(["ADMIN"]);

    const res = await suspendUser(
      req(`/api/admin/users/${admin.user.id}/suspend`, {
        method: "POST",
        cookie: admin.cookie,
        body: { suspended: true, reason: "Self-harm attempt" },
      }),
      at(admin.user.id),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("unprocessable");
  });

  test("listing suspend and unsuspend writes audit rows", async () => {
    const admin = await seedSession(["ADMIN"]);
    const host = await testDb.user.create({
      data: { email: "host1@example.com", name: "Host 1", roles: ["HOST"] },
    });
    const listing = await testDb.listing.create({
      data: {
        hostId: host.id,
        title: "Test Spot",
        description: "Test description",
        address: "123 FC Road",
        locality: "Shivajinagar",
        city: "Pune",
        lat: 18.53,
        lng: 73.84,
        approxLat: 18.53,
        approxLng: 73.84,
        spaceType: "OPEN",
        vehicleTypes: ["SEDAN"],
        status: "PUBLISHED",
      },
    });

    const resSuspend = await suspendListing(
      req(`/api/admin/listings/${listing.id}/suspend`, {
        method: "POST",
        cookie: admin.cookie,
        body: { suspended: true, reason: "Inaccurate address details" },
      }),
      at(listing.id),
    );
    expect(resSuspend.status).toBe(200);
    const lAfter = await testDb.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(lAfter.status).toBe("SUSPENDED");
    expect(lAfter.suspendedReason).toBe("Inaccurate address details");

    const auditSuspend = await testDb.auditLog.findFirstOrThrow({
      where: { targetId: listing.id, action: "listing.suspend" },
    });
    expect(auditSuspend.actorId).toBe(admin.user.id);
    expect(auditSuspend.reason).toBe("Inaccurate address details");

    // Unsuspend
    const resUnsuspend = await suspendListing(
      req(`/api/admin/listings/${listing.id}/suspend`, {
        method: "POST",
        cookie: admin.cookie,
        body: { suspended: false, reason: "Listing updated and compliant" },
      }),
      at(listing.id),
    );
    expect(resUnsuspend.status).toBe(200);
    const lUnsus = await testDb.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(lUnsus.status).toBe("PUBLISHED");
    expect(lUnsus.suspendedReason).toBeNull();
  });

  test("list users with pagination and search", async () => {
    const admin = await seedSession(["ADMIN"]);
    await testDb.user.create({
      data: {
        email: "searchtarget@example.com",
        name: "Special Search Target",
        roles: ["RENTER"],
      },
    });

    const res = await getUsers(
      req("/api/admin/users?q=Special&limit=10", { cookie: admin.cookie }),
      noParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].name).toBe("Special Search Target");
  });

  test("list reviews with moderationStatus filter and author first name", async () => {
    const admin = await seedSession(["ADMIN"]);
    const author = await seedSession(["RENTER"]);
    const host = await seedSession(["HOST"]);

    const listing = await testDb.listing.create({
      data: {
        hostId: host.user.id,
        title: "Koramangala Space",
        description: "Secure underground parking",
        address: "100 Feet Rd",
        locality: "Koramangala",
        city: "Bengaluru",
        lat: 12.9352,
        lng: 77.6245,
        approxLat: 12.935,
        approxLng: 77.624,
        spaceType: "COVERED",
        vehicleTypes: ["SEDAN"],
        status: "PUBLISHED",
      },
    });

    const endAt = new Date();
    const startAt = new Date(Date.now() - 3600000);
    const booking = await testDb.booking.create({
      data: {
        renterId: author.user.id,
        listingId: listing.id,
        rentalType: "HOURLY",
        startAt,
        endAt,
        blockedUntil: endAt,
        status: "COMPLETED",
        subtotalPaise: 10000,
        renterFeePaise: 0,
        commissionPaise: 1000,
        hostEarningsPaise: 9000,
        totalPaise: 10000,
        currency: "INR",
      },
    });

    await testDb.review.create({
      data: {
        bookingId: booking.id,
        listingId: listing.id,
        authorId: author.user.id,
        rating: 4,
        comment: "Great spot, easy access",
        moderationStatus: "PENDING",
      },
    });

    const res = await getReviews(
      req("/api/admin/reviews?moderationStatus=PENDING", { cookie: admin.cookie }),
      noParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].listingTitle).toBe("Koramangala Space");
    expect(body.items[0].moderationStatus).toBe("PENDING");
    expect(body.items[0].rating).toBe(4);
  });
});
