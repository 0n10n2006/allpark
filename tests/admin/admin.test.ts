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
const { GET: getPhotos } = await import("@/app/api/admin/photos/route");
const { POST: moderatePhoto } = await import("@/app/api/admin/photos/[id]/moderate/route");
const { POST: retryJob } = await import("@/app/api/admin/jobs/[id]/retry/route");
const { POST: retryNotification } = await import("@/app/api/admin/notifications/[id]/retry/route");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const at = (id: string) => ({ params: Promise.resolve({ id }) });
const { seedListing } = await import("../booking/fixtures");

describe("M1: a suspended or unverified host's listings stop being bookable", () => {
  const post = (
    handler: typeof suspendUser,
    path: string,
    cookie: string,
    id: string,
    body: object,
  ) => handler(req(path, { method: "POST", cookie, body }), at(id));
  const statusOf = async (id: string) =>
    (await testDb.listing.findUniqueOrThrow({ where: { id } })).status;

  test("suspend moves PUBLISHED listings to SUSPENDED (audited); unsuspend restores only those", async () => {
    const admin = await seedSession(["ADMIN"]);
    const listing = await seedListing();
    await testDb.user.update({
      where: { id: listing.hostId },
      data: { hostVerificationStatus: "VERIFIED" },
    });
    const manual = await seedListing({
      hostId: listing.hostId,
      status: "SUSPENDED",
      suspendedReason: "spam",
    });
    const path = `/api/admin/users/${listing.hostId}/suspend`;
    const off = await post(suspendUser, path, admin.cookie, listing.hostId, {
      suspended: true,
      reason: "Fraud",
    });
    expect(off.status).toBe(200);
    expect(await testDb.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({
      status: "SUSPENDED",
      suspendedReason: "owner_suspended",
    });
    expect(
      await testDb.auditLog.count({
        where: { targetId: listing.id, action: "listing.suspend", reason: "owner_suspended" },
      }),
    ).toBe(1);
    await post(suspendUser, path, admin.cookie, listing.hostId, {
      suspended: false,
      reason: "Appeal won",
    });
    expect(await statusOf(listing.id)).toBe("PUBLISHED");
    expect(await statusOf(manual.id)).toBe("SUSPENDED");
  });

  test("REJECTED suspends the host's listings; VERIFIED again restores them", async () => {
    const admin = await seedSession(["ADMIN"]);
    const listing = await seedListing();
    const path = `/api/admin/users/${listing.hostId}/verify-host`;
    await post(verifyHost, path, admin.cookie, listing.hostId, {
      decision: "REJECTED",
      reason: "Bad documents",
    });
    expect(await testDb.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({
      status: "SUSPENDED",
      suspendedReason: "host_unverified",
    });
    await post(verifyHost, path, admin.cookie, listing.hostId, {
      decision: "VERIFIED",
      reason: "Documents ok",
    });
    expect(await statusOf(listing.id)).toBe("PUBLISHED");
  });
});

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

    const resPhotos = await getPhotos(
      req("/api/admin/photos", { cookie: renter.cookie }),
      noParams,
    );
    expect(resPhotos.status).toBe(403);

    const resModeratePhoto = await moderatePhoto(
      req(`/api/admin/photos/${targetId}/moderate`, {
        method: "POST",
        cookie: renter.cookie,
        body: { decision: "APPROVED", reason: "Clean photo" },
      }),
      at(targetId),
    );
    expect(resModeratePhoto.status).toBe(403);

    const resRetryJob = await retryJob(
      req(`/api/admin/jobs/${targetId}/retry`, {
        method: "POST",
        cookie: renter.cookie,
        body: { reason: "Need to retry" },
      }),
      at(targetId),
    );
    expect(resRetryJob.status).toBe(403);

    const resRetryNotif = await retryNotification(
      req(`/api/admin/notifications/${targetId}/retry`, {
        method: "POST",
        cookie: renter.cookie,
        body: { reason: "Need to retry" },
      }),
      at(targetId),
    );
    expect(resRetryNotif.status).toBe(403);
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

  test("list photos with status filter and listing title", async () => {
    const admin = await seedSession(["ADMIN"]);
    const host = await seedSession(["HOST"]);

    const listing = await testDb.listing.create({
      data: {
        hostId: host.user.id,
        title: "Indiranagar Spot",
        description: "Open parking space",
        address: "12th Main Rd",
        locality: "Indiranagar",
        city: "Bengaluru",
        lat: 12.9716,
        lng: 77.6412,
        approxLat: 12.971,
        approxLng: 77.641,
        spaceType: "OPEN",
        vehicleTypes: ["HATCHBACK"],
        status: "PUBLISHED",
      },
    });

    const photoPending = await testDb.listingPhoto.create({
      data: {
        listingId: listing.id,
        url: "https://example.com/photo-pending.jpg",
        publicId: "photo-pending",
        position: 0,
        moderationStatus: "PENDING",
      },
    });

    await testDb.listingPhoto.create({
      data: {
        listingId: listing.id,
        url: "https://example.com/photo-approved.jpg",
        publicId: "photo-approved",
        position: 1,
        moderationStatus: "APPROVED",
      },
    });

    // Default or ?status=PENDING
    const resPending = await getPhotos(
      req("/api/admin/photos?status=PENDING", { cookie: admin.cookie }),
      noParams,
    );
    expect(resPending.status).toBe(200);
    const pendingBody = await resPending.json();
    expect(pendingBody.items.length).toBe(1);
    expect(pendingBody.items[0].id).toBe(photoPending.id);
    expect(pendingBody.items[0].listingTitle).toBe("Indiranagar Spot");
    expect(pendingBody.items[0].moderationStatus).toBe("PENDING");

    // ?status=APPROVED
    const resApproved = await getPhotos(
      req("/api/admin/photos?status=APPROVED", { cookie: admin.cookie }),
      noParams,
    );
    expect(resApproved.status).toBe(200);
    const approvedBody = await resApproved.json();
    expect(approvedBody.items.length).toBe(1);
    expect(approvedBody.items[0].moderationStatus).toBe("APPROVED");

    // All photos without status filter
    const resAll = await getPhotos(
      req("/api/admin/photos", { cookie: admin.cookie }),
      noParams,
    );
    expect(resAll.status).toBe(200);
    const allBody = await resAll.json();
    expect(allBody.items.length).toBe(2);
  });

  test("photo moderation: approve and reject write audit log with reason", async () => {
    const admin = await seedSession(["ADMIN"]);
    const host = await seedSession(["HOST"]);

    const listing = await testDb.listing.create({
      data: {
        hostId: host.user.id,
        title: "Whitefield Garage",
        description: "Secure lockup garage",
        address: "ITPL Main Rd",
        locality: "Whitefield",
        city: "Bengaluru",
        lat: 12.9698,
        lng: 77.7499,
        approxLat: 12.969,
        approxLng: 77.749,
        spaceType: "COVERED",
        vehicleTypes: ["SUV"],
        status: "PUBLISHED",
      },
    });

    const photo = await testDb.listingPhoto.create({
      data: {
        listingId: listing.id,
        url: "https://example.com/test-photo.jpg",
        publicId: "test-photo-public",
        position: 0,
        moderationStatus: "PENDING",
      },
    });

    // Reject photo
    const resReject = await moderatePhoto(
      req(`/api/admin/photos/${photo.id}/moderate`, {
        method: "POST",
        cookie: admin.cookie,
        body: { decision: "REJECTED", reason: "Inappropriate photo content" },
      }),
      at(photo.id),
    );
    expect(resReject.status).toBe(200);
    const rejectBody = await resReject.json();
    expect(rejectBody.ok).toBe(true);

    const dbPhotoAfterReject = await testDb.listingPhoto.findUnique({ where: { id: photo.id } });
    expect(dbPhotoAfterReject?.moderationStatus).toBe("REJECTED");

    const rejectAudit = await testDb.auditLog.findFirst({
      where: {
        action: "photo.moderate",
        targetId: photo.id,
      },
    });
    expect(rejectAudit).not.toBeNull();
    expect(rejectAudit?.actorId).toBe(admin.user.id);
    expect(rejectAudit?.reason).toBe("Inappropriate photo content");
    expect(rejectAudit?.metadata).toMatchObject({
      decision: "REJECTED",
      listingId: listing.id,
    });

    // Re-moderate to Approved
    const resApprove = await moderatePhoto(
      req(`/api/admin/photos/${photo.id}/moderate`, {
        method: "POST",
        cookie: admin.cookie,
        body: { decision: "APPROVED", reason: "Photo verified and approved" },
      }),
      at(photo.id),
    );
    expect(resApprove.status).toBe(200);
    const approveBody = await resApprove.json();
    expect(approveBody.ok).toBe(true);

    const dbPhotoAfterApprove = await testDb.listingPhoto.findUnique({ where: { id: photo.id } });
    expect(dbPhotoAfterApprove?.moderationStatus).toBe("APPROVED");
  });

  test("retry dead job resets status to PENDING, attempts to 0, runAt now, and creates audit log", async () => {
    const admin = await seedSession(["ADMIN"]);

    const job = await testDb.job.create({
      data: {
        type: "bookings.expireHolds",
        payload: {},
        status: "DEAD",
        attempts: 5,
        maxAttempts: 5,
        lastError: "Connection timeout after 5 attempts",
        runAt: new Date(Date.now() - 3600000),
      },
    });

    const res = await retryJob(
      req(`/api/admin/jobs/${job.id}/retry`, {
        method: "POST",
        cookie: admin.cookie,
        body: { reason: "Database pool recovered, retrying dead hold expiry job" },
      }),
      at(job.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.auditLogId).toBeDefined();

    const dbJob = await testDb.job.findUnique({ where: { id: job.id } });
    expect(dbJob?.status).toBe("PENDING");
    expect(dbJob?.attempts).toBe(0);
    expect(dbJob?.lastError).toBeNull();
    expect(dbJob?.lockedAt).toBeNull();
    expect(dbJob?.lockedBy).toBeNull();
    expect(dbJob?.runAt.getTime()).toBeGreaterThan(Date.now() - 10000);

    const audit = await testDb.auditLog.findFirst({
      where: {
        action: "job.retry",
        targetId: job.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(admin.user.id);
    expect(audit?.reason).toBe("Database pool recovered, retrying dead hold expiry job");
    expect(audit?.metadata).toMatchObject({
      previousStatus: "DEAD",
      type: "bookings.expireHolds",
    });
  });

  test("retry non-dead job returns 409 conflict", async () => {
    const admin = await seedSession(["ADMIN"]);

    const job = await testDb.job.create({
      data: {
        type: "system.noop",
        payload: {},
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
      },
    });

    const res = await retryJob(
      req(`/api/admin/jobs/${job.id}/retry`, {
        method: "POST",
        cookie: admin.cookie,
        body: { reason: "Attempting retry on pending job" },
      }),
      at(job.id),
    );
    expect(res.status).toBe(409);
  });

  test("retry failed notification resets status to PENDING, re-enqueues delivery job, and creates audit log", async () => {
    const admin = await seedSession(["ADMIN"]);
    const user = await seedSession(["RENTER"]);

    const notification = await testDb.notification.create({
      data: {
        userId: user.user.id,
        type: "booking.confirmed",
        channel: "EMAIL",
        payload: {},
        status: "FAILED",
        attempts: 5,
        lastError: "Email send failed: 550 Mailbox unavailable",
        idempotencyKey: "notif-failed-123",
      },
    });

    // Also simulate existing dead delivery job
    const deliveryKey = `notification:${notification.id}`;
    await testDb.job.create({
      data: {
        type: "notifications.deliver",
        payload: { notificationId: notification.id },
        idempotencyKey: deliveryKey,
        status: "DEAD",
        attempts: 5,
        maxAttempts: 5,
        lastError: "Email send failed",
      },
    });

    const res = await retryNotification(
      req(`/api/admin/notifications/${notification.id}/retry`, {
        method: "POST",
        cookie: admin.cookie,
        body: { reason: "User updated email address and provider issue resolved" },
      }),
      at(notification.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Notification reset
    const dbNotif = await testDb.notification.findUnique({ where: { id: notification.id } });
    expect(dbNotif?.status).toBe("PENDING");
    expect(dbNotif?.attempts).toBe(0);
    expect(dbNotif?.lastError).toBeNull();

    // Delivery job reset
    const dbJob = await testDb.job.findUnique({ where: { idempotencyKey: deliveryKey } });
    expect(dbJob?.status).toBe("PENDING");
    expect(dbJob?.attempts).toBe(0);
    expect(dbJob?.lastError).toBeNull();
    expect(dbJob?.lockedAt).toBeNull();

    // Audit log
    const audit = await testDb.auditLog.findFirst({
      where: {
        action: "notification.retry",
        targetId: notification.id,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(admin.user.id);
    expect(audit?.reason).toBe("User updated email address and provider issue resolved");
  });

  test("retry non-failed notification returns 409 conflict", async () => {
    const admin = await seedSession(["ADMIN"]);
    const user = await seedSession(["RENTER"]);

    const notification = await testDb.notification.create({
      data: {
        userId: user.user.id,
        type: "booking.confirmed",
        channel: "EMAIL",
        payload: {},
        status: "SENT",
        sentAt: new Date(),
        attempts: 1,
        idempotencyKey: "notif-sent-123",
      },
    });

    const res = await retryNotification(
      req(`/api/admin/notifications/${notification.id}/retry`, {
        method: "POST",
        cookie: admin.cookie,
        body: { reason: "Attempting retry on already sent notification" },
      }),
      at(notification.id),
    );
    expect(res.status).toBe(409);
  });
});
