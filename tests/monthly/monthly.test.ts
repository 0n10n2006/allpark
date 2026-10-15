import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { monthlyTermEnd } from "@/server/availability/service";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const {
  onMonthlyConfirmed,
  renewMonthly,
  cancelMonthly,
  getMonthlyAgreement,
  handleRenewalReminder,
  handleMonthlyExpire,
  handleCloseTerm,
} = await import("@/server/monthly/service");
const { seedListing, seedQuote, seedUser, seedVehicle, ist, outcome } =
  await import("../booking/fixtures");

import type { CurrentUser } from "@/server/auth/guards";
import type { UserRole } from "@/generated/prisma/client";

function asUser(id: string, roles: UserRole[] = ["RENTER"]): CurrentUser {
  return {
    id,
    name: "User",
    email: `${id}@test.local`,
    image: null,
    roles,
    hostVerificationStatus: "NOT_STARTED",
  };
}

beforeEach(truncateAll);
afterAll(() => testDb.$disconnect());

describe("monthly rentals (FR-09)", () => {
  it("no charge calls in src/server/monthly", () => {
    const dir = path.resolve("src/server/monthly");
    const files = readdirSync(dir);
    const banned = [
      /capturePayment/i,
      /createOrder/i,
      /providerPayment/i,
      /getPaymentProvider/i,
      /razorpay/i,
      /\.charge\b/i,
    ];
    for (const f of files) {
      if (!f.endsWith(".ts")) continue;
      const content = readFileSync(path.join(dir, f), "utf8");
      for (const pattern of banned) {
        expect(
          pattern.test(content),
          `Found forbidden charge call matching ${pattern} in src/server/monthly/${f}`,
        ).toBe(false);
      }
    }
  });

  it("agreement creation: onMonthlyConfirmed creates a MonthlyAgreement and links the booking", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);

    const startAt = ist("10:00", 10);
    const endAt = monthlyTermEnd(startAt);
    const quote = await seedQuote({
      listingId: listing.id,
      renterId: renter.id,
      vehicleId: vehicle.id,
      startAt,
      endAt,
      rentalType: "MONTHLY",
    });

    const booking = await testDb.booking.create({
      data: {
        listingId: listing.id,
        renterId: renter.id,
        vehicleId: vehicle.id,
        rentalType: "MONTHLY",
        startAt,
        endAt,
        blockedUntil: endAt,
        status: "CONFIRMED",
        subtotalPaise: 500_000,
        commissionPaise: 50_000,
        hostEarningsPaise: 450_000,
        totalPaise: 500_000,
        currency: "INR",
        quoteId: quote.id,
      },
    });

    const agreement = await testDb.$transaction((tx) => onMonthlyConfirmed(tx, booking.id));
    expect(agreement).not.toBeNull();
    expect(agreement!.renterId).toBe(renter.id);
    expect(agreement!.listingId).toBe(listing.id);
    expect(agreement!.status).toBe("ACTIVE");
    expect(agreement!.currentTermStartAt.getTime()).toBe(startAt.getTime());
    expect(agreement!.currentTermEndAt.getTime()).toBe(endAt.getTime());

    // Booking is linked
    const updatedBooking = await testDb.booking.findUnique({ where: { id: booking.id } });
    expect(updatedBooking?.monthlyAgreementId).toBe(agreement!.id);

    // Audit log
    const audit = await testDb.auditLog.findFirst({
      where: { targetType: "MonthlyAgreement", targetId: agreement!.id, action: "monthly.created" },
    });
    expect(audit).not.toBeNull();

    // Jobs enqueued: renewalReminder at termEnd - 7 days, expire at termEnd
    const reminderJob = await testDb.job.findFirst({
      where: { type: "monthly.renewalReminder" },
    });
    expect(reminderJob).not.toBeNull();
    const expectedReminderAt = new Date(endAt.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(reminderJob!.runAt.getTime()).toBe(expectedReminderAt.getTime());
    const closeJob = await testDb.job.findUniqueOrThrow({
      where: { idempotencyKey: `monthly.closeTerm:${booking.id}` },
    });
    expect(closeJob.runAt.getTime()).toBe(endAt.getTime());

    const expireJob = await testDb.job.findFirst({
      where: { type: "monthly.expire" },
    });
    expect(expireJob).not.toBeNull();
    expect(expireJob!.runAt.getTime()).toBe(endAt.getTime());
  });

  it("renewal blocked (409) when a short-term booking occupies part of the next term", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const otherUser = await seedUser();
    const vehicle = await seedVehicle(renter.id);
    const otherVehicle = await seedVehicle(otherUser.id);

    const startAt = ist("10:00", 10);
    const endAt = monthlyTermEnd(startAt);

    // Seed existing active agreement
    const agreement = await testDb.monthlyAgreement.create({
      data: {
        renterId: renter.id,
        listingId: listing.id,
        vehicleId: vehicle.id,
        monthlyPaise: 500_000,
        currency: "INR",
        startAt,
        currentTermStartAt: startAt,
        currentTermEndAt: endAt,
        status: "ACTIVE",
      },
    });

    // Seed a conflicting short-term booking during the NEXT term [endAt, nextEnd)
    const conflictStart = new Date(endAt.getTime() + 2 * 24 * 60 * 60 * 1000);
    const conflictEnd = new Date(conflictStart.getTime() + 2 * 60 * 60 * 1000);
    const conflictQuote = await seedQuote({
      listingId: listing.id,
      renterId: otherUser.id,
      vehicleId: otherVehicle.id,
      startAt: conflictStart,
      endAt: conflictEnd,
      rentalType: "HOURLY",
    });

    await testDb.booking.create({
      data: {
        listingId: listing.id,
        renterId: otherUser.id,
        vehicleId: otherVehicle.id,
        rentalType: "HOURLY",
        startAt: conflictStart,
        endAt: conflictEnd,
        blockedUntil: conflictEnd,
        status: "CONFIRMED",
        subtotalPaise: 10_000,
        commissionPaise: 1_000,
        hostEarningsPaise: 9_000,
        totalPaise: 10_000,
        currency: "INR",
        quoteId: conflictQuote.id,
      },
    });

    // Attempt renewal: must be blocked with 409
    const res = await outcome(renewMonthly(asUser(renter.id), agreement.id, "key-renew-conflict"));
    expect(res.status).toBe(409);
    expect(res.reason).toBe("slot_unavailable");
  });

  it("successful renewal creates a PENDING_PAYMENT hold for exactly the next IST month", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);

    const startAt = ist("10:00", 10);
    const endAt = monthlyTermEnd(startAt);

    const agreement = await testDb.monthlyAgreement.create({
      data: {
        renterId: renter.id,
        listingId: listing.id,
        vehicleId: vehicle.id,
        monthlyPaise: 500_000,
        currency: "INR",
        startAt,
        currentTermStartAt: startAt,
        currentTermEndAt: endAt,
        status: "ACTIVE",
      },
    });

    const result = await renewMonthly(asUser(renter.id), agreement.id, "key-renew-success");

    expect(result.hold).toBeDefined();
    expect(result.hold.status).toBe("PENDING_PAYMENT");
    expect(new Date(result.hold.startAt).getTime()).toBe(endAt.getTime());

    const expectedNextEnd = monthlyTermEnd(endAt);
    expect(new Date(result.hold.endAt).getTime()).toBe(expectedNextEnd.getTime());
    expect(result.quote).toBeDefined();
    expect(result.bookingId).toBe(result.hold.id);

    // Verify hold row in DB
    const holdRow = await testDb.booking.findUnique({ where: { id: result.hold.id } });
    expect(holdRow?.status).toBe("PENDING_PAYMENT");
    expect(holdRow?.monthlyAgreementId).toBe(agreement.id);
  });

  it("non-renter cannot renew (404)", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const stranger = await seedUser();
    const vehicle = await seedVehicle(renter.id);

    const startAt = ist("10:00", 10);
    const endAt = monthlyTermEnd(startAt);

    const agreement = await testDb.monthlyAgreement.create({
      data: {
        renterId: renter.id,
        listingId: listing.id,
        vehicleId: vehicle.id,
        monthlyPaise: 500_000,
        currency: "INR",
        startAt,
        currentTermStartAt: startAt,
        currentTermEndAt: endAt,
        status: "ACTIVE",
      },
    });

    const res = await outcome(renewMonthly(asUser(stranger.id), agreement.id, "key-stranger"));
    expect(res.status).toBe(404);
  });

  it("reminder job fires at the right time (runAt assertion) and is idempotent", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);

    const startAt = ist("10:00", 10);
    const endAt = monthlyTermEnd(startAt);

    const agreement = await testDb.monthlyAgreement.create({
      data: {
        renterId: renter.id,
        listingId: listing.id,
        vehicleId: vehicle.id,
        monthlyPaise: 500_000,
        currency: "INR",
        startAt,
        currentTermStartAt: startAt,
        currentTermEndAt: endAt,
        status: "ACTIVE",
      },
    });

    // Run reminder job
    await handleRenewalReminder(agreement.id, endAt.toISOString());

    const audit1 = await testDb.auditLog.findMany({
      where: {
        targetType: "MonthlyAgreement",
        targetId: agreement.id,
        action: "monthly.reminder_sent",
      },
    });
    expect(audit1).toHaveLength(1);

    // Running again does not duplicate
    await handleRenewalReminder(agreement.id, endAt.toISOString());
    const audit2 = await testDb.auditLog.findMany({
      where: {
        targetType: "MonthlyAgreement",
        targetId: agreement.id,
        action: "monthly.reminder_sent",
      },
    });
    expect(audit2.length).toBeGreaterThanOrEqual(1);
    const reminders = await testDb.notification.findMany({
      where: { type: "MONTHLY_RENEWAL_DUE" },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ userId: renter.id });
  });

  it("expire marks EXPIRED + audit when unpaid, and does nothing when renewed", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);

    const startAt = ist("10:00", 10);
    const endAt = monthlyTermEnd(startAt);

    // Case 1: Unpaid agreement expires
    const agreementUnpaid = await testDb.monthlyAgreement.create({
      data: {
        renterId: renter.id,
        listingId: listing.id,
        vehicleId: vehicle.id,
        monthlyPaise: 500_000,
        currency: "INR",
        startAt,
        currentTermStartAt: startAt,
        currentTermEndAt: endAt,
        status: "ACTIVE",
      },
    });

    await handleMonthlyExpire(agreementUnpaid.id, endAt.toISOString());

    const expired = await testDb.monthlyAgreement.findUnique({
      where: { id: agreementUnpaid.id },
    });
    expect(expired?.status).toBe("EXPIRED");
    expect(expired?.endedAt?.getTime()).toBe(endAt.getTime());
    expect(
      await testDb.notification.findMany({
        select: { userId: true, type: true },
        orderBy: { type: "asc" },
      }),
    ).toEqual([
      { userId: listing.hostId, type: "MONTHLY_EXPIRED_HOST" },
      { userId: renter.id, type: "MONTHLY_EXPIRED_RENTER" },
    ]);

    const audit = await testDb.auditLog.findFirst({
      where: {
        targetType: "MonthlyAgreement",
        targetId: agreementUnpaid.id,
        action: "monthly.expired",
      },
    });
    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe("unpaid_term_expired");
    expect((audit?.metadata as Record<string, unknown> | null)?.actor).toBe("system");

    // Case 2: Renewed agreement with a CONFIRMED booking for next term does NOT expire
    const agreementRenewed = await testDb.monthlyAgreement.create({
      data: {
        renterId: renter.id,
        listingId: listing.id,
        vehicleId: vehicle.id,
        monthlyPaise: 500_000,
        currency: "INR",
        startAt,
        currentTermStartAt: startAt,
        currentTermEndAt: endAt,
        status: "ACTIVE",
      },
    });

    const nextEnd = monthlyTermEnd(endAt);
    const nextQuote = await seedQuote({
      listingId: listing.id,
      renterId: renter.id,
      vehicleId: vehicle.id,
      startAt: endAt,
      endAt: nextEnd,
      rentalType: "MONTHLY",
    });

    await testDb.booking.create({
      data: {
        listingId: listing.id,
        renterId: renter.id,
        vehicleId: vehicle.id,
        rentalType: "MONTHLY",
        startAt: endAt,
        endAt: nextEnd,
        blockedUntil: nextEnd,
        status: "CONFIRMED",
        subtotalPaise: 500_000,
        commissionPaise: 50_000,
        hostEarningsPaise: 450_000,
        totalPaise: 500_000,
        currency: "INR",
        quoteId: nextQuote.id,
        monthlyAgreementId: agreementRenewed.id,
      },
    });

    // Trigger expire for agreementRenewed
    await handleMonthlyExpire(agreementRenewed.id, endAt.toISOString());

    const stillActive = await testDb.monthlyAgreement.findUnique({
      where: { id: agreementRenewed.id },
    });
    expect(stillActive?.status).toBe("ACTIVE");
  });

  it("cancellation notice sets the agreement to end at current termEnd and records AuditLog", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);

    const startAt = ist("10:00", 10);
    const endAt = monthlyTermEnd(startAt);

    const agreement = await testDb.monthlyAgreement.create({
      data: {
        renterId: renter.id,
        listingId: listing.id,
        vehicleId: vehicle.id,
        monthlyPaise: 500_000,
        currency: "INR",
        startAt,
        currentTermStartAt: startAt,
        currentTermEndAt: endAt,
        status: "ACTIVE",
      },
    });

    const res = await cancelMonthly(asUser(renter.id), agreement.id, "Moving to another state");
    expect(res.success).toBe(true);
    expect(res.status).toBe("NOTICE_GIVEN");
    expect(new Date(res.endedAt).getTime()).toBe(endAt.getTime());

    const updated = await testDb.monthlyAgreement.findUnique({ where: { id: agreement.id } });
    expect(updated?.status).toBe("NOTICE_GIVEN");
    expect(updated?.noticeGivenAt).not.toBeNull();
    expect(updated?.endedAt?.getTime()).toBe(endAt.getTime());

    const audit = await testDb.auditLog.findFirst({
      where: {
        targetType: "MonthlyAgreement",
        targetId: agreement.id,
        action: "monthly.cancellation_notice",
      },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(renter.id);
    const notice = await testDb.notification.findFirstOrThrow({
      where: { type: "MONTHLY_NOTICE_GIVEN" },
    });
    expect(notice.userId).toBe(listing.hostId);
    expect(JSON.stringify(notice.payload)).not.toContain("Moving to another state");
    expect(audit?.reason).toBe("Moving to another state");
  });

  it("history GET returns agreement, terms (bookings), payments, and notices", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);

    const startAt = ist("10:00", 10);
    const endAt = monthlyTermEnd(startAt);

    const agreement = await testDb.monthlyAgreement.create({
      data: {
        renterId: renter.id,
        listingId: listing.id,
        vehicleId: vehicle.id,
        monthlyPaise: 500_000,
        currency: "INR",
        startAt,
        currentTermStartAt: startAt,
        currentTermEndAt: endAt,
        status: "ACTIVE",
      },
    });

    const quote = await seedQuote({
      listingId: listing.id,
      renterId: renter.id,
      vehicleId: vehicle.id,
      startAt,
      endAt,
      rentalType: "MONTHLY",
    });

    const booking = await testDb.booking.create({
      data: {
        listingId: listing.id,
        renterId: renter.id,
        vehicleId: vehicle.id,
        rentalType: "MONTHLY",
        startAt,
        endAt,
        blockedUntil: endAt,
        status: "CONFIRMED",
        subtotalPaise: 500_000,
        commissionPaise: 50_000,
        hostEarningsPaise: 450_000,
        totalPaise: 500_000,
        currency: "INR",
        quoteId: quote.id,
        monthlyAgreementId: agreement.id,
      },
    });

    await testDb.payment.create({
      data: {
        bookingId: booking.id,
        providerOrderId: "order_hist_1",
        providerPaymentId: "pay_hist_1",
        amountPaise: 500_000,
        currency: "INR",
        status: "SUCCEEDED",
      },
    });

    await testDb.auditLog.create({
      data: {
        actorId: renter.id,
        action: "monthly.created",
        targetType: "MonthlyAgreement",
        targetId: agreement.id,
        reason: "initial_term",
      },
    });

    // Renter can fetch
    const history = await getMonthlyAgreement(asUser(renter.id), agreement.id);
    expect(history.id).toBe(agreement.id);
    expect(history.terms).toHaveLength(1);
    expect(history.terms[0].id).toBe(booking.id);
    expect(history.terms[0].payments).toHaveLength(1);
    expect(history.terms[0].payments[0].status).toBe("SUCCEEDED");
    expect(history.notices).toHaveLength(1);
    expect(history.notices[0].action).toBe("monthly.created");

    // Host can also fetch
    const hostHistory = await getMonthlyAgreement(asUser(listing.hostId, ["HOST"]), agreement.id);
    expect(hostHistory.id).toBe(agreement.id);

    // Stranger gets 404
    const stranger = await seedUser();
    const res = await outcome(getMonthlyAgreement(asUser(stranger.id), agreement.id));
    expect(res.status).toBe(404);
  });

  it("closeTerm completes the ended term's own booking as system, leaving the renewal alone", async () => {
    const listing = await seedListing();
    const renter = await seedUser();
    const vehicle = await seedVehicle(renter.id);
    const start1 = new Date(Date.now() - 40 * 24 * 3600_000);
    const end1 = monthlyTermEnd(start1);
    const term = (startAt: Date, endAt: Date) =>
      testDb.booking.create({
        data: {
          listingId: listing.id,
          renterId: renter.id,
          vehicleId: vehicle.id,
          rentalType: "MONTHLY",
          startAt,
          endAt,
          blockedUntil: endAt,
          status: "CONFIRMED",
          subtotalPaise: 500_000,
          commissionPaise: 50_000,
          hostEarningsPaise: 450_000,
          totalPaise: 500_000,
        },
      });
    const ended = await term(start1, end1);
    const renewal = await term(end1, monthlyTermEnd(end1));

    await handleCloseTerm(ended.id);
    await handleCloseTerm(ended.id); // a retried job is a no-op
    await handleCloseTerm(renewal.id); // not ended yet

    const rows = await testDb.booking.findMany({ select: { id: true, status: true } });
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: ended.id, status: "COMPLETED" },
        { id: renewal.id, status: "CONFIRMED" },
      ]),
    );
    const audits = await testDb.auditLog.findMany({ where: { action: "booking.transition" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      targetId: ended.id,
      actorId: null,
      reason: "monthly_term_ended",
      metadata: { from: "CONFIRMED", to: "COMPLETED" },
    });
  });
});
