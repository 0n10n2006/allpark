import { Uuid, type QuoteLineItem } from "@/contracts";
import { getActivePolicy } from "@/config/policy";
import type { Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { createHold, monthlyTermEnd } from "@/server/availability/service";
import { getBooking } from "@/server/bookings/service";
import { transition } from "@/server/bookings/state";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { enqueue } from "@/server/jobs";
import { notify } from "@/server/notifications";
import { createQuote } from "@/server/pricing/quotes";

// FR-09: Monthly rentals and manual renewal.
// NO automated charge paths anywhere here; payment uses standard /checkout/[bookingId] flow.

export const CLOSE_TERM_JOB = "monthly.closeTerm";

/** At term end the term's own booking completes (renewed or not), so the host can be paid for it. */
function scheduleCloseTerm(bookingId: string, termEnd: Date) {
  return enqueue(
    CLOSE_TERM_JOB,
    { bookingId },
    { runAt: termEnd, idempotencyKey: `${CLOSE_TERM_JOB}:${bookingId}` },
  );
}

export async function onMonthlyConfirmed(tx: Prisma.TransactionClient, bookingId: string) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
  });
  if (!booking || booking.rentalType !== "MONTHLY") return null;

  const policy = await getActivePolicy();
  const reminderDays = policy.monthlyRenewalReminderDays ?? 7;
  const unpaidGraceDays = policy.unpaidGraceDays ?? 0;

  const termStart = booking.startAt;
  const termEnd = booking.endAt;
  const reminderAt = new Date(termEnd.getTime() - reminderDays * 24 * 60 * 60 * 1000);
  const expireAt = new Date(termEnd.getTime() + unpaidGraceDays * 24 * 60 * 60 * 1000);

  if (booking.monthlyAgreementId) {
    const agreement = await tx.monthlyAgreement.update({
      where: { id: booking.monthlyAgreementId },
      data: {
        currentTermStartAt: termStart,
        currentTermEndAt: termEnd,
        status: "ACTIVE",
        endedAt: null,
        renewalDueAt: termEnd,
        renewalReminderAt: reminderAt,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: null,
        action: "monthly.renewed",
        targetType: "MonthlyAgreement",
        targetId: agreement.id,
        reason: "payment_confirmed",
        metadata: { bookingId, termStart: termStart.toISOString(), termEnd: termEnd.toISOString() },
      },
    });

    await enqueue(
      "monthly.renewalReminder",
      { agreementId: agreement.id, termEndAt: termEnd.toISOString() },
      {
        runAt: reminderAt,
        idempotencyKey: `monthly:reminder:${agreement.id}:${termEnd.toISOString()}`,
      },
    );

    await enqueue(
      "monthly.expire",
      { agreementId: agreement.id, termEndAt: termEnd.toISOString() },
      {
        runAt: expireAt,
        idempotencyKey: `monthly:expire:${agreement.id}:${termEnd.toISOString()}`,
      },
    );

    await scheduleCloseTerm(booking.id, termEnd);

    return agreement;
  } else {
    const agreement = await tx.monthlyAgreement.create({
      data: {
        renterId: booking.renterId,
        listingId: booking.listingId,
        vehicleId: booking.vehicleId,
        monthlyPaise: booking.subtotalPaise,
        currency: booking.currency,
        startAt: termStart,
        currentTermStartAt: termStart,
        currentTermEndAt: termEnd,
        noticePeriodDays: reminderDays,
        status: "ACTIVE",
        renewalDueAt: termEnd,
        renewalReminderAt: reminderAt,
      },
    });

    await tx.booking.update({
      where: { id: booking.id },
      data: { monthlyAgreementId: agreement.id },
    });

    await tx.auditLog.create({
      data: {
        actorId: null,
        action: "monthly.created",
        targetType: "MonthlyAgreement",
        targetId: agreement.id,
        reason: "initial_term_confirmed",
        metadata: { bookingId, termStart: termStart.toISOString(), termEnd: termEnd.toISOString() },
      },
    });

    await enqueue(
      "monthly.renewalReminder",
      { agreementId: agreement.id, termEndAt: termEnd.toISOString() },
      {
        runAt: reminderAt,
        idempotencyKey: `monthly:reminder:${agreement.id}:${termEnd.toISOString()}`,
      },
    );

    await enqueue(
      "monthly.expire",
      { agreementId: agreement.id, termEndAt: termEnd.toISOString() },
      {
        runAt: expireAt,
        idempotencyKey: `monthly:expire:${agreement.id}:${termEnd.toISOString()}`,
      },
    );

    await scheduleCloseTerm(booking.id, termEnd);

    return agreement;
  }
}

export async function renewMonthly(
  user: CurrentUser,
  agreementId: string,
  idempotencyKey?: string,
) {
  if (!Uuid.safeParse(agreementId).success) {
    throw new HttpError("not_found", "Monthly agreement not found");
  }
  const agreement = await db.monthlyAgreement.findUnique({
    where: { id: agreementId },
    include: { listing: true },
  });
  if (!agreement || agreement.renterId !== user.id) {
    throw new HttpError("not_found", "Monthly agreement not found");
  }
  if (agreement.status !== "ACTIVE" && agreement.status !== "NOTICE_GIVEN") {
    throw new HttpError("conflict", "This agreement cannot be renewed", {
      reason: "agreement_not_active",
    });
  }

  // Revalidate listing
  const listing = await db.listing.findUnique({
    where: { id: agreement.listingId },
  });
  if (!listing || listing.status !== "PUBLISHED") {
    throw new HttpError("conflict", "This listing is no longer available for booking", {
      reason: "listing_unavailable",
    });
  }
  if (listing.monthlyPaise == null) {
    throw new HttpError("conflict", "This listing does not offer monthly rentals", {
      reason: "rental_type_not_offered",
    });
  }

  const startAt = agreement.currentTermEndAt;
  const endAt = monthlyTermEnd(startAt);

  // If a hold already exists for this exact term on this agreement and is still valid
  const existingHold = await db.booking.findFirst({
    where: {
      monthlyAgreementId: agreement.id,
      startAt,
      status: "PENDING_PAYMENT",
      holdExpiresAt: { gt: new Date() },
    },
  });
  if (existingHold && existingHold.quoteId) {
    const existingQuote = await db.priceQuote.findUnique({ where: { id: existingHold.quoteId } });
    if (existingQuote) {
      const holdDetail = await getBooking(existingHold.id, user);
      return {
        hold: holdDetail,
        quote: {
          id: existingQuote.id,
          listingId: existingQuote.listingId,
          vehicleId: existingQuote.vehicleId,
          rentalType: existingQuote.rentalType,
          startAt: existingQuote.startAt.toISOString(),
          endAt: existingQuote.endAt.toISOString(),
          lineItems: existingQuote.lineItems as unknown as QuoteLineItem[],
          subtotal: { paise: existingQuote.subtotalPaise, currency: "INR" as const },
          renterFee: { paise: existingQuote.renterFeePaise, currency: "INR" as const },
          total: { paise: existingQuote.totalPaise, currency: "INR" as const },
          policyVersion: 1,
          terms: { cancellation: "", overstay: "", gracePeriodMinutes: 10 },
          expiresAt: existingQuote.expiresAt.toISOString(),
        },
        bookingId: existingHold.id,
        quoteId: existingQuote.id,
      };
    }
  }

  // Determine vehicle
  let vehicleId = agreement.vehicleId;
  if (!vehicleId) {
    const defaultVehicle = await db.vehicle.findFirst({
      where: { userId: user.id, deletedAt: null },
    });
    vehicleId = defaultVehicle?.id ?? null;
  }
  if (!vehicleId) {
    throw new HttpError("unprocessable", "Choose a vehicle for this booking", {
      reason: "vehicle_required",
    });
  }

  const quote = await createQuote(user, {
    listingId: agreement.listingId,
    vehicleId: vehicleId ?? undefined,
    rentalType: "MONTHLY",
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
  });

  const holdKey = idempotencyKey || `monthly:renew:${agreement.id}:${startAt.toISOString()}`;
  const booking = await createHold({
    listingId: agreement.listingId,
    renterId: user.id,
    vehicleId,
    rentalType: "MONTHLY",
    startAt,
    endAt,
    quoteId: quote.id,
    idempotencyKey: holdKey,
    monthlyAgreementId: agreement.id,
  });

  const holdDetail = await getBooking(booking.id, user);
  return {
    hold: holdDetail,
    quote,
    bookingId: booking.id,
    quoteId: quote.id,
  };
}

export async function cancelMonthly(user: CurrentUser, agreementId: string, reason: string) {
  if (!Uuid.safeParse(agreementId).success) {
    throw new HttpError("not_found", "Monthly agreement not found");
  }
  const agreement = await db.monthlyAgreement.findUnique({
    where: { id: agreementId },
    include: { listing: true },
  });
  if (!agreement || agreement.renterId !== user.id) {
    throw new HttpError("not_found", "Monthly agreement not found");
  }
  if (agreement.status !== "ACTIVE") {
    throw new HttpError(
      "conflict",
      "Only active monthly agreements can give notice of cancellation",
      {
        reason: "agreement_not_active",
      },
    );
  }

  const updated = await db.monthlyAgreement.update({
    where: { id: agreement.id },
    data: {
      status: "NOTICE_GIVEN",
      noticeGivenAt: new Date(),
      endedAt: agreement.currentTermEndAt,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: user.id,
      action: "monthly.cancellation_notice",
      targetType: "MonthlyAgreement",
      targetId: agreement.id,
      reason,
      metadata: { termEndAt: agreement.currentTermEndAt.toISOString(), reason },
    },
  });

  // The renter's free-text reason stays in the audit log, out of the notification.
  await notify(
    agreement.listing.hostId,
    "MONTHLY_NOTICE_GIVEN",
    {
      agreementId: agreement.id,
      listingTitle: agreement.listing.title,
      endAt: agreement.currentTermEndAt.toISOString(),
    },
    {
      idempotencyKey: `monthly:notice:host:${agreement.id}:${agreement.currentTermEndAt.toISOString()}`,
    },
  );

  return {
    success: true,
    agreementId: updated.id,
    status: updated.status,
    endedAt: updated.endedAt!.toISOString(),
  };
}

export async function getMonthlyAgreement(user: CurrentUser, agreementId: string) {
  if (!Uuid.safeParse(agreementId).success) {
    throw new HttpError("not_found", "Monthly agreement not found");
  }
  const agreement = await db.monthlyAgreement.findUnique({
    where: { id: agreementId },
    include: {
      listing: {
        select: { id: true, title: true, locality: true, address: true, hostId: true },
      },
      bookings: {
        include: {
          payments: { orderBy: { createdAt: "desc" } },
        },
        orderBy: { startAt: "asc" },
      },
    },
  });
  if (!agreement) {
    throw new HttpError("not_found", "Monthly agreement not found");
  }
  const isRenter = agreement.renterId === user.id;
  const isHost = agreement.listing.hostId === user.id;
  const isAdmin = user.roles.includes("ADMIN");
  if (!isRenter && !isHost && !isAdmin) {
    throw new HttpError("not_found", "Monthly agreement not found");
  }

  const notices = await db.auditLog.findMany({
    where: {
      targetType: "MonthlyAgreement",
      targetId: agreement.id,
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    id: agreement.id,
    listingId: agreement.listingId,
    renterId: agreement.renterId,
    vehicleId: agreement.vehicleId,
    status: agreement.status,
    startAt: agreement.startAt.toISOString(),
    currentTermStartAt: agreement.currentTermStartAt.toISOString(),
    currentTermEndAt: agreement.currentTermEndAt.toISOString(),
    noticePeriodDays: agreement.noticePeriodDays,
    noticeGivenAt: agreement.noticeGivenAt?.toISOString() ?? null,
    renewalReminderAt: agreement.renewalReminderAt?.toISOString() ?? null,
    renewalDueAt: agreement.renewalDueAt?.toISOString() ?? null,
    endedAt: agreement.endedAt?.toISOString() ?? null,
    monthlyRate: { paise: agreement.monthlyPaise, currency: agreement.currency },
    listing: {
      id: agreement.listing.id,
      title: agreement.listing.title,
      locality: agreement.listing.locality,
      address: isRenter || isHost || isAdmin ? agreement.listing.address : null,
    },
    terms: agreement.bookings.map((b) => ({
      id: b.id,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      status: b.status,
      total: { paise: b.totalPaise, currency: b.currency },
      payments: b.payments.map((p) => ({
        id: p.id,
        amount: { paise: p.amountPaise, currency: p.currency },
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      })),
    })),
    notices: notices.map((n) => ({
      id: n.id,
      action: n.action,
      reason: n.reason,
      createdAt: n.createdAt.toISOString(),
      metadata: (n.metadata as Record<string, unknown>) ?? null,
    })),
    createdAt: agreement.createdAt.toISOString(),
  };
}

export async function handleRenewalReminder(agreementId: string, termEndAt: string) {
  const agreement = await db.monthlyAgreement.findUnique({
    where: { id: agreementId },
    include: { listing: { select: { title: true } } },
  });
  if (!agreement || agreement.status !== "ACTIVE") return;
  if (agreement.currentTermEndAt.toISOString() !== termEndAt) return;

  await notify(
    agreement.renterId,
    "MONTHLY_RENEWAL_DUE",
    { agreementId: agreement.id, listingTitle: agreement.listing.title, endAt: termEndAt },
    { idempotencyKey: `monthly:reminder:${agreement.id}:${termEndAt}` },
  );

  await db.auditLog.create({
    data: {
      actorId: null,
      action: "monthly.reminder_sent",
      targetType: "MonthlyAgreement",
      targetId: agreement.id,
      reason: "reminder_due",
      metadata: { actor: "system", termEndAt },
    },
  });
}

export async function handleMonthlyExpire(agreementId: string, termEndAt: string) {
  const agreement = await db.monthlyAgreement.findUnique({
    where: { id: agreementId },
    include: { listing: true },
  });
  if (!agreement || (agreement.status !== "ACTIVE" && agreement.status !== "NOTICE_GIVEN")) return;
  if (agreement.currentTermEndAt.toISOString() !== termEndAt) return;

  // Check if next term is confirmed
  const confirmedNext = await db.booking.findFirst({
    where: {
      monthlyAgreementId: agreement.id,
      startAt: agreement.currentTermEndAt,
      status: { in: ["CONFIRMED", "ACTIVE"] },
    },
  });
  if (confirmedNext) {
    // Already renewed and confirmed
    return;
  }

  await db.monthlyAgreement.update({
    where: { id: agreement.id },
    data: {
      status: "EXPIRED",
      endedAt: agreement.currentTermEndAt,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: null,
      action: "monthly.expired",
      targetType: "MonthlyAgreement",
      targetId: agreement.id,
      reason: "unpaid_term_expired",
      metadata: { actor: "system", termEndAt },
    },
  });

  const payload = {
    agreementId: agreement.id,
    listingTitle: agreement.listing.title,
    endAt: termEndAt,
  };
  await notify(agreement.renterId, "MONTHLY_EXPIRED_RENTER", payload, {
    idempotencyKey: `monthly:expired:renter:${agreement.id}:${termEndAt}`,
  });
  await notify(agreement.listing.hostId, "MONTHLY_EXPIRED_HOST", payload, {
    idempotencyKey: `monthly:expired:host:${agreement.id}:${termEndAt}`,
  });
}

/** Job at termEnd: CONFIRMED/ACTIVE → COMPLETED, audited as system. Anything else is left alone. */
export async function handleCloseTerm(bookingId: string) {
  await db.$transaction(async (tx) => {
    // Database clock, like claimDue: a worker clock running behind would skip the close for good.
    const [b] = await tx.$queryRaw<{ status: string; rentalType: string; ended: boolean }[]>`
      SELECT status::text, "rentalType"::text, "endAt" <= now() AS ended FROM "Booking"
      WHERE id = ${bookingId}::uuid FOR UPDATE`;
    if (!b || b.rentalType !== "MONTHLY" || !b.ended) return;
    if (b.status !== "CONFIRMED" && b.status !== "ACTIVE") return;
    await transition(tx, bookingId, "COMPLETED", null, "monthly_term_ended");
  });
}
