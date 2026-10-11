import type {
  BookingDetail,
  CheckInBody,
  CheckOutBody,
  ExtendBookingResponse,
  OverstayIncident,
  QuoteLineItem,
  ReportIncidentBody,
} from "@/contracts";
import {
  cancellationText,
  getActivePolicy,
  overstayText,
  POLICY_DEFAULTS,
  type ActivePolicy,
} from "@/config/policy";
import type { BookingStatus, Prisma } from "@/generated/prisma/client";
import { formatIST } from "@/lib/time";
import type { CurrentUser } from "@/server/auth/guards";
import { extendBookingTx, findConflicts, scheduleProblem } from "@/server/availability/service";
import { getBooking } from "@/server/bookings/service";
import { transition } from "@/server/bookings/state";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { enqueue } from "@/server/jobs";
import { listingFolder } from "@/server/listings/cloudinary";
import { cancelScheduled, notify } from "@/server/notifications";
import { sessionHooks } from "@/server/payments/session-hooks";
import { createExtensionOrder } from "@/server/payments/service";
import { priceFor } from "@/server/pricing/calc";

// FR-07, FR-08, PRD §5. The session after confirmation: check-in, durable reminders, the
// grace → overstay jobs, paid extensions, and overstay incidents. Nothing here charges a
// fee: a missed checkout only ever opens an incident for support to review.
//
// Keys carry the target time, so a rescheduled reminder or job never collides with the
// cancelled/stale one: notifications `session:<id>:<kind>:<targetISO>[:<offset>]`, jobs
// `<type>:<id>:<endAtISO>`. Grace jobs can't be cancelled, so they no-op once endAt moved.

type Tx = Prisma.TransactionClient;
const MIN = 60_000;
/** "Start parking" opens this long before startAt (FR-07 arrival window) and closes at endAt. */
export const ARRIVAL_EARLY_MINUTES = 15;
/** ARRIVAL_UPCOMING goes out this long before startAt. */
export const ARRIVAL_REMINDER_MINUTES = 30;
// Literals, not imported constants: this module is reached through the jobs import cycle.
export const START_GRACE_JOB = "sessions.startGrace";
export const GRACE_EXPIRED_JOB = "sessions.graceExpired";

const IN_SESSION: BookingStatus[] = ["ACTIVE", "GRACE_PERIOD", "OVERSTAY"];
const EXTENDABLE: BookingStatus[] = ["CONFIRMED", "ACTIVE", "GRACE_PERIOD"];
const SCHEDULABLE: BookingStatus[] = ["CONFIRMED", "ACTIVE", "GRACE_PERIOD"];

const sessionPrefix = (id: string) => `session:${id}:`;
const conflict = (reason: string, message: string) =>
  new HttpError("conflict", message, { reason });
const unprocessable = (reason: string, message: string) =>
  new HttpError("unprocessable", message, { reason });

const include = {
  listing: { select: { hostId: true, title: true } },
  quote: { select: { policyVersion: true } },
} satisfies Prisma.BookingInclude;
type Row = Prisma.BookingGetPayload<{ include: typeof include }>;

/** Renter or host of the booking; anyone else gets 404 so existence doesn't leak. */
async function loadForParty(id: string, user: CurrentUser) {
  const b = await db.booking.findUnique({ where: { id }, include });
  if (!b || (b.renterId !== user.id && b.listing.hostId !== user.id))
    throw new HttpError("not_found", "Booking not found");
  return { b, isRenter: b.renterId === user.id, isHost: b.listing.hostId === user.id };
}

/** Terms as agreed: the policy version the booking's quote was priced under. */
async function policyOf(b: Pick<Row, "quote">): Promise<ActivePolicy> {
  const v = b.quote?.policyVersion;
  if (!v) return getActivePolicy();
  return { ...POLICY_DEFAULTS, ...(v.policy as object), id: v.id, version: v.version };
}

const payload = (b: Row) => ({
  bookingId: b.id,
  listingTitle: b.listing.title,
  startAt: b.startAt.toISOString(),
  endAt: b.endAt.toISOString(),
});

/**
 * Durable reminders and grace jobs for a booking's current times (FR-07 AC1). Idempotent:
 * call it on confirmation and again after an extension. Reminders already in the past
 * are skipped rather than sent late with the wrong wording.
 */
export async function scheduleSessionJobs(bookingId: string) {
  const b = await db.booking.findUnique({ where: { id: bookingId }, include });
  if (!b || !SCHEDULABLE.includes(b.status)) return;
  const policy = await policyOf(b);
  const now = Date.now();
  const end = b.endAt.toISOString();
  const start = b.startAt.getTime();
  if (b.status === "CONFIRMED" && start > now)
    await notify(b.renterId, "ARRIVAL_UPCOMING", payload(b), {
      scheduledAt: new Date(Math.max(now, start - ARRIVAL_REMINDER_MINUTES * MIN)),
      idempotencyKey: `${sessionPrefix(b.id)}arrival:${b.startAt.toISOString()}`,
    });
  for (const offset of policy.reminderOffsetsMinutes) {
    const at = b.endAt.getTime() - offset * MIN;
    // SESSION_ENDING only words 30 and 10 minutes.
    if (at <= now || (offset !== 30 && offset !== 10)) continue;
    await notify(
      b.renterId,
      "SESSION_ENDING",
      { ...payload(b), minutesLeft: offset },
      {
        scheduledAt: new Date(at),
        idempotencyKey: `${sessionPrefix(b.id)}ending:${end}:${offset}`,
      },
    );
  }
  const job = { bookingId: b.id, endAt: end };
  await enqueue(START_GRACE_JOB, job, {
    runAt: b.endAt,
    idempotencyKey: `${START_GRACE_JOB}:${b.id}:${end}`,
  });
  await enqueue(GRACE_EXPIRED_JOB, job, {
    runAt: new Date(b.endAt.getTime() + policy.gracePeriodMinutes * MIN),
    idempotencyKey: `${GRACE_EXPIRED_JOB}:${b.id}:${end}`,
  });
}

/**
 * POST /api/bookings/:id/check-in. The renter starts parking (CONFIRMED → ACTIVE) inside
 * the arrival window; with `asHost` the host confirms arrival, which also starts the
 * session if the renter hasn't. Repeats are no-ops.
 */
export async function checkIn(
  user: CurrentUser,
  id: string,
  body: CheckInBody,
): Promise<BookingDetail> {
  const { b, isRenter, isHost } = await loadForParty(id, user);
  const now = new Date();
  const inWindow =
    now.getTime() >= b.startAt.getTime() - ARRIVAL_EARLY_MINUTES * MIN && now < b.endAt;
  const note = body.note ? { note: body.note } : {};

  if (body.asHost) {
    if (!isHost) throw new HttpError("forbidden", "Only the host can confirm arrival");
    if (b.status !== "CONFIRMED" && !IN_SESSION.includes(b.status))
      throw conflict("not_in_session", "This booking has no session to confirm");
    if (b.status === "CONFIRMED" && !inWindow)
      throw unprocessable("outside_arrival_window", "Arrival can't be confirmed at this time");
    await db.$transaction(async (tx) => {
      if (b.status === "CONFIRMED") {
        await transition(tx, id, "ACTIVE", user.id, "host_confirmed_arrival");
        await tx.booking.update({ where: { id }, data: { checkedInAt: now } });
      }
      const already = await tx.sessionEvent.findFirst({
        where: { bookingId: id, type: "HOST_CONFIRMED_ARRIVAL" },
      });
      if (!already)
        await tx.sessionEvent.create({
          data: {
            bookingId: id,
            type: "HOST_CONFIRMED_ARRIVAL",
            actorId: user.id,
            occurredAt: now,
            metadata: note,
          },
        });
    });
    return getBooking(id, user);
  }

  if (!isRenter) throw new HttpError("forbidden", "Only the renter can start parking");
  if (b.checkedInAt && IN_SESSION.includes(b.status)) return getBooking(id, user);
  if (b.status !== "CONFIRMED" && b.status !== "ACTIVE")
    throw conflict("not_in_session", "This booking can't be checked in");
  if (!inWindow)
    throw unprocessable(
      "outside_arrival_window",
      `You can start parking from ${ARRIVAL_EARLY_MINUTES} minutes before your start time until it ends`,
    );
  await db.$transaction(async (tx) => {
    // ACTIVE without a check-in: the host confirmed first, or an extension revived a no-show.
    if (b.status === "CONFIRMED") await transition(tx, id, "ACTIVE", user.id, "check_in");
    await tx.booking.update({ where: { id }, data: { checkedInAt: now } });
    await tx.sessionEvent.create({
      data: { bookingId: id, type: "CHECK_IN", actorId: user.id, occurredAt: now, metadata: note },
    });
  });
  return getBooking(id, user);
}

/** Closes open incidents on a booking (inside the caller's transaction) and audits each. */
async function resolveOpenIncidents(
  tx: Tx,
  bookingId: string,
  actorId: string | null,
  resolution: string,
  reason: string,
) {
  const open = await tx.overstayIncident.findMany({
    where: { bookingId, status: "OPEN" },
    select: { id: true },
  });
  for (const { id } of open) {
    await tx.overstayIncident.update({
      where: { id },
      data: { status: "RESOLVED", resolution, resolvedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: "incident.resolved",
        targetType: "OverstayIncident",
        targetId: id,
        reason,
        metadata: { bookingId, resolution, feePaise: 0 },
      },
    });
  }
}

/**
 * POST /api/bookings/:id/check-out. Renter, or the host confirming departure:
 * ACTIVE/GRACE_PERIOD/OVERSTAY → COMPLETED. Open incidents resolve as "departed" with no
 * fee, and pending reminders are cancelled. A repeat is a no-op.
 */
export async function checkOut(
  user: CurrentUser,
  id: string,
  body: CheckOutBody,
): Promise<BookingDetail> {
  const { b, isRenter } = await loadForParty(id, user);
  if (b.status === "COMPLETED" && b.checkedOutAt) return getBooking(id, user);
  if (!IN_SESSION.includes(b.status))
    throw conflict("not_in_session", "This booking isn't in a parking session");
  const now = new Date();
  await db.$transaction(async (tx) => {
    await transition(tx, id, "COMPLETED", user.id, "checked_out");
    await tx.booking.update({ where: { id }, data: { checkedOutAt: now } });
    await tx.sessionEvent.create({
      data: {
        bookingId: id,
        type: "CHECK_OUT",
        actorId: user.id,
        occurredAt: now,
        metadata: { by: isRenter ? "renter" : "host", ...(body.note ? { note: body.note } : {}) },
      },
    });
    await resolveOpenIncidents(tx, id, user.id, "departed", "checked_out");
  });
  await cancelScheduled(sessionPrefix(id));
  return getBooking(id, user);
}

export type GraceJob = { bookingId: string; endAt: string };

/**
 * Job at endAt: ACTIVE → GRACE_PERIOD. A booking never checked in also enters the grace
 * period, recorded as NO_SHOW_OR_UNCONFIRMED: no penalty, and graceExpired still notifies.
 */
export async function startGrace({ bookingId, endAt }: GraceJob) {
  await db.$transaction(async (tx) => {
    const b = await tx.booking.findUnique({ where: { id: bookingId } });
    // A job for an end that an extension superseded is a no-op; a newer job owns the new end.
    if (!b || b.endAt.toISOString() !== endAt) return;
    if (b.status !== "ACTIVE" && b.status !== "CONFIRMED") return;
    const noShow = b.status === "CONFIRMED";
    await transition(
      tx,
      bookingId,
      "GRACE_PERIOD",
      null,
      noShow ? "no_show_or_unconfirmed" : "end_time_reached",
    );
    await tx.sessionEvent.create({
      data: {
        bookingId,
        type: noShow ? "NO_SHOW_OR_UNCONFIRMED" : "GRACE_STARTED",
        metadata: { endAt },
      },
    });
  });
}

/**
 * Job at endAt + grace: GRACE_PERIOD → OVERSTAY, opens a system incident, and notifies
 * renter and host (FR-07). No fee: overstayFeeEnabled is off and a missed checkout alone
 * proves nothing (FR-07 AC4, FR-08). A retry after a crash re-sends with the same keys.
 */
export async function graceExpired({ bookingId, endAt }: GraceJob) {
  const overstay = await db.$transaction(async (tx) => {
    const b = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!b || b.endAt.toISOString() !== endAt) return false;
    if (b.status === "GRACE_PERIOD") {
      await transition(tx, bookingId, "OVERSTAY", null, "grace_expired");
      await tx.sessionEvent.create({
        data: { bookingId, type: "OVERSTAY_STARTED", metadata: { endAt } },
      });
      const open = await tx.overstayIncident.findFirst({ where: { bookingId, status: "OPEN" } });
      if (!open) {
        const incident = await tx.overstayIncident.create({
          data: { bookingId, reportedById: null, evidenceUrls: [] },
        });
        await tx.auditLog.create({
          data: {
            actorId: null,
            action: "incident.opened",
            targetType: "OverstayIncident",
            targetId: incident.id,
            reason: "grace_expired",
            metadata: { actor: "system", bookingId },
          },
        });
      }
      return true;
    }
    return b.status === "OVERSTAY";
  });
  if (!overstay) return;
  const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, include });
  const key = `${sessionPrefix(bookingId)}grace-expired:${endAt}`;
  await notify(b.renterId, "GRACE_EXPIRED_RENTER", payload(b), { idempotencyKey: `${key}:renter` });
  await notify(b.listing.hostId, "GRACE_EXPIRED_HOST", payload(b), {
    idempotencyKey: `${key}:host`,
  });
}

/**
 * POST /api/bookings/:id/extend (renter). Fresh availability for [endAt, newEndAt + buffer)
 * excluding this booking (FR-07 AC2), then a quote for the extra time under the booking's
 * policy version. The extra time is price(start → newEnd) − price(start → end), so hourly
 * rounding and minimum durations follow the booking's own rental type. Nothing moves until
 * the payment settles (applyExtensionTx); a zero-cost extension applies at once.
 */
export async function requestExtension(
  user: CurrentUser,
  id: string,
  newEndAtIso: string,
): Promise<ExtendBookingResponse> {
  const b = await db.booking.findUnique({
    where: { id },
    include: {
      listing: { include: { availabilityRules: true, exceptions: true } },
      quote: { select: { policyVersion: true } },
    },
  });
  if (!b || (b.renterId !== user.id && b.listing.hostId !== user.id))
    throw new HttpError("not_found", "Booking not found");
  if (b.renterId !== user.id) throw new HttpError("forbidden", "Only the renter can extend");
  if (!EXTENDABLE.includes(b.status))
    throw conflict("not_extendable", "This booking can't be extended now");
  if (b.rentalType === "MONTHLY")
    throw unprocessable("monthly_renews", "Monthly bookings are renewed, not extended");
  const newEndAt = new Date(newEndAtIso);
  if (!(newEndAt > b.endAt) || newEndAt.getTime() <= Date.now())
    throw unprocessable("invalid_interval", "Choose a new end time after the current one");
  const problem = scheduleProblem(b.listing, b.startAt, newEndAt, b.rentalType);
  if (problem) throw unprocessable(problem.reason, problem.message);
  const blockedUntil = new Date(newEndAt.getTime() + b.listing.turnoverBufferMinutes * MIN);
  const others = (await findConflicts(b.listingId, b.endAt, blockedUntil)).filter(
    (c) => c.id !== b.id,
  );
  if (others.length)
    throw conflict("slot_unavailable", "The space is booked after your current end time");

  const policy = await policyOf(b);
  const before = priceFor(b.listing, b.rentalType, b.startAt, b.endAt, policy);
  const after = priceFor(b.listing, b.rentalType, b.startAt, newEndAt, policy);
  const subtotalPaise = Math.max(0, after.subtotalPaise - before.subtotalPaise);
  const renterFeePaise = Math.max(0, after.renterFeePaise - before.renterFeePaise);
  const commissionPaise = Math.min(
    subtotalPaise,
    Math.max(0, after.commissionPaise - before.commissionPaise),
  );
  const totalPaise = subtotalPaise + renterFeePaise;
  const money = (paise: number) => ({ paise, currency: "INR" as const });
  const lineItems: QuoteLineItem[] = [
    {
      code: "extension",
      label: `Extra time until ${formatIST(newEndAt, "d MMM, h:mm a")} IST`,
      kind: "charge",
      amount: money(subtotalPaise),
    },
    { code: "renter_fee", label: "Service fee", kind: "fee", amount: money(renterFeePaise) },
    { code: "tax", label: "Taxes", kind: "tax", amount: money(0) },
  ];
  const quote = await db.priceQuote.create({
    data: {
      listingId: b.listingId,
      renterId: user.id,
      vehicleId: b.vehicleId,
      rentalType: b.rentalType,
      startAt: b.endAt,
      endAt: newEndAt,
      lineItems,
      subtotalPaise,
      renterFeePaise,
      commissionPaise,
      hostEarningsPaise: subtotalPaise - commissionPaise,
      totalPaise,
      currency: b.currency,
      policyVersionId: policy.id,
      expiresAt: new Date(Date.now() + 15 * MIN),
    },
  });

  let payment: ExtendBookingResponse["payment"] = null;
  if (totalPaise === 0) {
    const applied = await db.$transaction((tx) => applyExtensionTx(tx, b.id, quote.id));
    if (!applied) throw conflict("slot_unavailable", "The space is no longer free for that time");
    await afterExtension(b.id, quote.id, true);
  } else {
    payment = await createExtensionOrder(user, b.id, quote.id);
    if (payment)
      await notify(
        b.listing.hostId,
        "EXTENSION_REQUESTED",
        {
          bookingId: b.id,
          listingTitle: b.listing.title,
          startAt: b.startAt.toISOString(),
          endAt: b.endAt.toISOString(),
          newEndAt: newEndAt.toISOString(),
        },
        { idempotencyKey: `${sessionPrefix(b.id)}extension:${quote.id}:requested` },
      );
  }

  return {
    booking: await getBooking(b.id, user),
    quote: {
      id: quote.id,
      listingId: quote.listingId,
      vehicleId: quote.vehicleId,
      rentalType: quote.rentalType,
      startAt: quote.startAt.toISOString(),
      endAt: quote.endAt.toISOString(),
      lineItems,
      subtotal: money(subtotalPaise),
      renterFee: money(renterFeePaise),
      total: money(totalPaise),
      policyVersion: policy.version,
      terms: {
        cancellation: cancellationText(policy, b.listing.cancellationPolicy, b.rentalType),
        overstay: overstayText(policy),
        gracePeriodMinutes: policy.gracePeriodMinutes,
      },
      expiresAt: quote.expiresAt.toISOString(),
    },
    requiresPayment: totalPaise > 0,
    payment,
  };
}

/**
 * Applies a settled extension inside the settlement transaction: endAt/blockedUntil move
 * only if the booking still ends where the quote started and the exclusion constraint
 * agrees (false → payments refunds the capture). Bumps the booking's totals by the delta
 * and brings a GRACE_PERIOD booking back to ACTIVE.
 */
export async function applyExtensionTx(tx: Tx, bookingId: string, quoteId: string) {
  const [b] = await tx.$queryRaw<{ status: BookingStatus; buffer: number }[]>`
    SELECT b.status, l."turnoverBufferMinutes" AS buffer
    FROM "Booking" b JOIN "Listing" l ON l.id = b."listingId"
    WHERE b.id = ${bookingId}::uuid FOR UPDATE OF b`;
  const q = await tx.priceQuote.findUnique({ where: { id: quoteId } });
  if (!b || !q) return false;
  const blockedUntil = new Date(q.endAt.getTime() + b.buffer * MIN);
  if (!(await extendBookingTx(tx, bookingId, q.startAt, q.endAt, blockedUntil))) return false;
  await tx.booking.update({
    where: { id: bookingId },
    data: {
      subtotalPaise: { increment: q.subtotalPaise },
      renterFeePaise: { increment: q.renterFeePaise },
      commissionPaise: { increment: q.commissionPaise },
      hostEarningsPaise: { increment: q.hostEarningsPaise },
      totalPaise: { increment: q.totalPaise },
    },
  });
  if (b.status === "GRACE_PERIOD" && q.endAt.getTime() > Date.now())
    await transition(tx, bookingId, "ACTIVE", null, "extended");
  await tx.sessionEvent.create({
    data: {
      bookingId,
      type: "EXTENDED",
      actorId: q.renterId,
      metadata: {
        fromEndAt: q.startAt.toISOString(),
        toEndAt: q.endAt.toISOString(),
        quoteId,
        totalPaise: q.totalPaise,
      },
    },
  });
  return true;
}

/** After commit: reschedule for the new end (old reminders cancelled) and tell the renter. */
export async function afterExtension(bookingId: string, quoteId: string, applied: boolean) {
  const q = await db.priceQuote.findUniqueOrThrow({ where: { id: quoteId } });
  if (applied) {
    await cancelScheduled(`${sessionPrefix(bookingId)}ending:${q.startAt.toISOString()}`);
    await scheduleSessionJobs(bookingId);
  }
  const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, include });
  await notify(
    b.renterId,
    "EXTENSION_OUTCOME",
    { ...payload(b), approved: applied },
    { idempotencyKey: `${sessionPrefix(bookingId)}extension:${quoteId}:outcome` },
  );
}

sessionHooks.confirmed = scheduleSessionJobs;
sessionHooks.applyExtension = applyExtensionTx;
sessionHooks.extensionSettled = afterExtension;

function incidentDto(i: {
  id: string;
  bookingId: string;
  reportedById: string | null;
  reportedAt: Date;
  evidenceUrls: string[];
  status: OverstayIncident["status"];
  resolution: string | null;
  resolvedAt: Date | null;
}): OverstayIncident {
  return {
    ...i,
    reportedAt: i.reportedAt.toISOString(),
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
  };
}

/** Evidence must be a delivery URL of our own Cloudinary uploads for this listing or booking. */
function isOurEvidence(raw: string, listingId: string, bookingId: string) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud) return false;
  const u = new URL(raw);
  return (
    u.protocol === "https:" &&
    u.hostname === "res.cloudinary.com" &&
    u.pathname.startsWith(`/${cloud}/`) &&
    (u.pathname.includes(`/${listingFolder(listingId)}/`) ||
      u.pathname.includes(`/incidents/${bookingId}/`))
  );
}

/**
 * POST /api/bookings/:id/incidents (host). Reports an overstay or blocked access with
 * evidence; updates the open incident if there is one (e.g. the system-opened one) and
 * notifies the renter. Support decides the outcome; nothing is charged here.
 */
export async function reportIncident(
  user: CurrentUser,
  id: string,
  body: ReportIncidentBody,
): Promise<OverstayIncident> {
  const { b, isHost } = await loadForParty(id, user);
  if (!isHost) throw new HttpError("forbidden", "Only the host can report an incident");
  if (!IN_SESSION.includes(b.status))
    throw conflict("not_in_session", "Incidents can be reported during a parking session");
  if (!body.evidenceUrls.every((u) => isOurEvidence(u, b.listingId, b.id)))
    throw unprocessable("invalid_evidence", "Evidence must be photos uploaded to ParkShare");

  const { incident, auditId } = await db.$transaction(async (tx) => {
    // Serialises with graceExpired so a booking never gets two open incidents.
    await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE id = ${id}::uuid FOR UPDATE`;
    const open = await tx.overstayIncident.findFirst({ where: { bookingId: id, status: "OPEN" } });
    const incident = open
      ? await tx.overstayIncident.update({
          where: { id: open.id },
          data: {
            reportedById: open.reportedById ?? user.id,
            evidenceUrls: [...new Set([...open.evidenceUrls, ...body.evidenceUrls])],
          },
        })
      : await tx.overstayIncident.create({
          data: { bookingId: id, reportedById: user.id, evidenceUrls: body.evidenceUrls },
        });
    await tx.sessionEvent.create({
      data: {
        bookingId: id,
        type: "NOTE",
        actorId: user.id,
        metadata: {
          kind: `incident.${body.kind.toLowerCase()}`,
          incidentId: incident.id,
          ...(body.note ? { note: body.note } : {}),
          evidenceUrls: body.evidenceUrls,
        },
      },
    });
    const audit = await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: open ? "incident.updated" : "incident.reported",
        targetType: "OverstayIncident",
        targetId: incident.id,
        reason: body.kind,
        metadata: { bookingId: id },
      },
    });
    return { incident, auditId: audit.id };
  });
  // ponytail: no incident template yet (FR-12); GRACE_EXPIRED_RENTER asks the renter to leave or contact support.
  await notify(b.renterId, "GRACE_EXPIRED_RENTER", payload(b), {
    idempotencyKey: `booking:${id}:incident:${auditId}`,
  });
  return incidentDto(incident);
}

/**
 * Support resolves an incident (wired by T4.4a/T4.6). Audited with the admin's reason; an
 * OVERSTAY booking closes as COMPLETED (FR-07: "close the session when support resolves").
 */
export async function resolveIncident(
  adminId: string,
  incidentId: string,
  resolution: string,
  reason: string,
): Promise<OverstayIncident> {
  const incident = await db.$transaction(async (tx) => {
    const open = await tx.overstayIncident.findUnique({ where: { id: incidentId } });
    if (!open) throw new HttpError("not_found", "Incident not found");
    if (open.status !== "OPEN")
      throw conflict("incident_closed", "This incident is already closed");
    const row = await tx.overstayIncident.update({
      where: { id: incidentId },
      data: { status: "RESOLVED", resolution, resolvedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "incident.resolved",
        targetType: "OverstayIncident",
        targetId: incidentId,
        reason,
        metadata: { bookingId: open.bookingId, resolution },
      },
    });
    const b = await tx.booking.findUniqueOrThrow({ where: { id: open.bookingId } });
    if (b.status === "OVERSTAY")
      await transition(tx, b.id, "COMPLETED", adminId, `incident_resolved: ${reason}`);
    return row;
  });
  await cancelScheduled(sessionPrefix(incident.bookingId));
  return incidentDto(incident);
}
