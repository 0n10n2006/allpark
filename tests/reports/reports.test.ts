import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { BookingStatus } from "@/generated/prisma/client";
import { testDb, truncateAll } from "../setup/db";
import { noParams, req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST: createReportRoute } = await import("@/app/api/reports/route");
const { GET: getAdminReportsRoute } = await import("@/app/api/admin/reports/route");
const { POST: resolveAdminReportRoute } =
  await import("@/app/api/admin/reports/[id]/resolve/route");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const at = (id: string) => ({ params: Promise.resolve({ id }) });

async function seedTestListing(hostId?: string) {
  const host = hostId
    ? { id: hostId }
    : await testDb.user.create({
        data: {
          email: "host@example.com",
          name: "Listing Host",
          roles: ["HOST"],
        },
      });

  return testDb.listing.create({
    data: {
      hostId: host.id,
      title: "Model Colony Bay",
      description: "Clean bay",
      address: "50 Model Colony",
      locality: "Model Colony",
      city: "Pune",
      lat: 18.535,
      lng: 73.835,
      approxLat: 18.536,
      approxLng: 73.836,
      spaceType: "OPEN",
      vehicleTypes: ["SEDAN"],
      hourlyPaise: 3000,
      minDurationMinutes: 60,
      status: "PUBLISHED",
    },
  });
}

async function seedTestBooking(
  renterId: string,
  listingId: string,
  status: BookingStatus = "CONFIRMED",
) {
  return testDb.booking.create({
    data: {
      renterId,
      listingId,
      rentalType: "HOURLY",
      startAt: new Date(Date.now() - 3600_000),
      endAt: new Date(Date.now() + 3600_000),
      blockedUntil: new Date(Date.now() + 3600_000),
      status,
      subtotalPaise: 5000,
      renterFeePaise: 0,
      commissionPaise: 500,
      hostEarningsPaise: 4500,
      totalPaise: 5000,
      currency: "INR",
    },
  });
}

describe("POST /api/reports", () => {
  test("reporting someone else's private booking → 404", async () => {
    const host = await seedSession(["HOST"]);
    const listing = await seedTestListing(host.user.id);
    const legitimateRenter = await seedSession(["RENTER"]);
    const thirdPartyUser = await seedSession(["RENTER"]);

    const booking = await seedTestBooking(legitimateRenter.user.id, listing.id);

    // Third-party attempting to report a booking they don't belong to
    const res = await createReportRoute(
      req("/api/reports", {
        method: "POST",
        cookie: thirdPartyUser.cookie,
        body: {
          targetType: "BOOKING",
          targetId: booking.id,
          reason: "ACCESS_PROBLEM",
          description: "Trying to probe another user's booking details.",
        },
      }),
      noParams,
    );

    // Must be 404 to prevent IDOR / private booking probing
    expect(res.status).toBe(404);

    // However, the booking's own renter CAN report it
    const renterRes = await createReportRoute(
      req("/api/reports", {
        method: "POST",
        cookie: legitimateRenter.cookie,
        body: {
          targetType: "BOOKING",
          targetId: booking.id,
          reason: "ACCESS_PROBLEM",
          description: "Gate was locked and host did not answer.",
        },
      }),
      noParams,
    );
    expect(renterRes.status).toBe(201);
    const renterBody = await renterRes.json();
    expect(renterBody.status).toBe("OPEN");

    // And the booking's host CAN report it
    const hostRes = await createReportRoute(
      req("/api/reports", {
        method: "POST",
        cookie: host.cookie,
        body: {
          targetType: "BOOKING",
          targetId: booking.id,
          reason: "SUSPICIOUS_BEHAVIOR",
          description: "Renter left unauthorized vehicle in the bay.",
        },
      }),
      noParams,
    );
    expect(hostRes.status).toBe(201);
  });

  test("evidence URLs: only our cloud's listing photos or booking evidence uploads (L1)", async () => {
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "parkshare-test");
    const listing = await seedTestListing();
    const user = await seedSession(["RENTER"]);
    const send = (url: string) =>
      createReportRoute(
        req("/api/reports", {
          method: "POST",
          cookie: user.cookie,
          body: {
            targetType: "LISTING",
            targetId: listing.id,
            reason: "INACCURATE_LISTING",
            description: "The photo does not match the actual gate number.",
            evidenceUrls: [url],
          },
        }),
        noParams,
      );
    const ours = "https://res.cloudinary.com/parkshare-test/image/upload";
    for (const ok of [
      `${ours}/v1234/listings/${listing.id}/photo1.jpg`,
      `${ours}/incidents/${listing.id}/abc_DEF-1.webp`,
    ])
      expect((await send(ok)).status, ok).toBe(201);
    for (const bad of [
      "https://attacker.example.com/evidence/pic.jpg",
      `https://res.cloudinary.com/attacker/image/upload/listings/${listing.id}/phish.jpg`,
      `http://res.cloudinary.com/parkshare-test/image/upload/listings/${listing.id}/x.jpg`,
      `https://res.cloudinary.com/parkshare-test/image/fetch/https://evil.example/listings/${listing.id}/x.jpg`,
      `${ours}/w_100/listings/${listing.id}/x.jpg`,
      `${ours}/listings/${listing.id}/x.svg`,
      `${ours}/v1234/evidence/photo1.jpg`,
      `${ours}/v1234/avatars/user.jpg`,
    ])
      expect((await send(bad)).status, bad).toBe(400);
    vi.unstubAllEnvs();
  });

  test("report rate limit → 429", async () => {
    const listing = await seedTestListing();
    const { cookie } = await seedSession(["RENTER"]);

    // Limit is 10 per hour
    for (let i = 0; i < 10; i++) {
      const res = await createReportRoute(
        req("/api/reports", {
          method: "POST",
          cookie,
          body: {
            targetType: "LISTING",
            targetId: listing.id,
            reason: "OTHER",
            description: `Testing rate limit report number ${i + 1}`,
          },
        }),
        noParams,
      );
      expect(res.status).toBe(201);
    }

    // 11th request in same window → 429
    const blockedRes = await createReportRoute(
      req("/api/reports", {
        method: "POST",
        cookie,
        body: {
          targetType: "LISTING",
          targetId: listing.id,
          reason: "OTHER",
          description: "This should be rate limited now.",
        },
      }),
      noParams,
    );
    expect(blockedRes.status).toBe(429);
  });
});

describe("Admin report queue and resolution", () => {
  test("admin resolve/moderate requires a reason, writes an audit, and non-admin → 403", async () => {
    const listing = await seedTestListing();
    const reporter = await seedSession(["RENTER"]);
    const admin = await seedSession(["ADMIN"]);

    const report = await testDb.report.create({
      data: {
        reporterId: reporter.user.id,
        targetType: "LISTING",
        targetId: listing.id,
        reason: "INACCURATE_LISTING",
        description: "The space height is only 180cm, not 220cm as advertised.",
        status: "OPEN",
      },
    });

    // Non-admin GET /api/admin/reports → 403
    const nonAdminGet = await getAdminReportsRoute(
      req("/api/admin/reports", { cookie: reporter.cookie }),
      noParams,
    );
    expect(nonAdminGet.status).toBe(403);

    // Non-admin POST /api/admin/reports/:id/resolve → 403
    const nonAdminResolve = await resolveAdminReportRoute(
      req(`/api/admin/reports/${report.id}/resolve`, {
        method: "POST",
        cookie: reporter.cookie,
        body: { action: "DISMISS", resolution: "Dismissed by user", reason: "Invalid" },
      }),
      at(report.id),
    );
    expect(nonAdminResolve.status).toBe(403);

    // Admin resolve without reason → 400
    const missingReason = await resolveAdminReportRoute(
      req(`/api/admin/reports/${report.id}/resolve`, {
        method: "POST",
        cookie: admin.cookie,
        body: { action: "DISMISS", resolution: "Dismissed due to lack of evidence." },
      }),
      at(report.id),
    );
    expect(missingReason.status).toBe(400);

    // Admin resolve DISMISS with reason → 200 and writes audit
    const dismissRes = await resolveAdminReportRoute(
      req(`/api/admin/reports/${report.id}/resolve`, {
        method: "POST",
        cookie: admin.cookie,
        body: {
          action: "DISMISS",
          resolution: "Measurement verified with host; description accurate.",
          reason: "Investigated on site and photos checked",
        },
      }),
      at(report.id),
    );
    expect(dismissRes.status).toBe(200);
    const dismissBody = await dismissRes.json();
    expect(dismissBody.ok).toBe(true);

    // Verify DB update
    const updatedReport = await testDb.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(updatedReport.status).toBe("DISMISSED");
    expect(updatedReport.resolution).toBe("Measurement verified with host; description accurate.");
    expect(updatedReport.resolvedById).toBe(admin.user.id);

    // Verify AuditLog
    const auditEntry = await testDb.auditLog.findUniqueOrThrow({
      where: { id: dismissBody.auditLogId },
    });
    expect(auditEntry).toMatchObject({
      actorId: admin.user.id,
      action: "report.dismiss",
      targetType: "Report",
      targetId: report.id,
      reason: "Investigated on site and photos checked",
    });
  });

  test("ACTION on a listing report suspends the listing", async () => {
    const listing = await seedTestListing();
    expect(listing.status).toBe("PUBLISHED");

    const reporter = await seedSession(["RENTER"]);
    const admin = await seedSession(["ADMIN"]);

    const report = await testDb.report.create({
      data: {
        reporterId: reporter.user.id,
        targetType: "LISTING",
        targetId: listing.id,
        reason: "FAKE_OR_UNAUTHORIZED_LISTING",
        description: "Listing belongs to another building and has no valid parking permission.",
        status: "OPEN",
      },
    });

    const actionRes = await resolveAdminReportRoute(
      req(`/api/admin/reports/${report.id}/resolve`, {
        method: "POST",
        cookie: admin.cookie,
        body: {
          action: "ACTION",
          resolution: "Listing verified as unauthorized; suspended pending ownership proof.",
          reason: "Confirmed lack of authority from society manager",
        },
      }),
      at(report.id),
    );
    expect(actionRes.status).toBe(200);

    // Verify report status is ACTIONED
    const updatedReport = await testDb.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(updatedReport.status).toBe("ACTIONED");

    // CRITICAL ACCEPTANCE: Verify that the listing was SUSPENDED!
    const suspendedListing = await testDb.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(suspendedListing.status).toBe("SUSPENDED");
    expect(suspendedListing.suspendedReason).toBe(
      "Confirmed lack of authority from society manager",
    );

    // Verify that suspendListing wrote its audit log entry as well
    const listingAudit = await testDb.auditLog.findFirst({
      where: {
        targetType: "Listing",
        targetId: listing.id,
        action: "listing.suspend",
      },
    });
    expect(listingAudit).not.toBeNull();
    expect(listingAudit?.actorId).toBe(admin.user.id);
  });
});
