import {
  type AvailabilityException,
  type AvailabilityRule,
  type CreateListingBody,
  type GetAvailabilityResponse,
  type HostStatusResponse,
  type ListingPhoto,
  OwnedListing,
  PublicListing,
  type UpdateListingBody,
  Uuid,
} from "@/contracts";
import { type ActivePolicy, cancellationText, getActivePolicy } from "@/config/policy";
import type { HostVerificationStatus, Prisma } from "@/generated/prisma/client";
import { type CurrentUser, assertOwner, requireVerifiedHost } from "@/server/auth/guards";
import { db } from "@/server/db";
import { audit } from "@/server/http/audit";
import { HttpError } from "@/server/http/errors";
import { listingFolder, photoUrl } from "./cloudinary";

type Issue = { path: (string | number)[]; message: string };

const MAX_PHOTOS = 20;
// Mirrors the booking_no_overlap predicate in the init migration.
const BLOCKING = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "ACTIVE",
  "GRACE_PERIOD",
  "OVERSTAY",
  "DISPUTED",
] as const;

const include = {
  photos: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
  host: { select: { id: true, name: true, hostVerificationStatus: true } },
} satisfies Prisma.ListingInclude;
type ListingRow = Prisma.ListingGetPayload<{ include: typeof include }>;

/** Rounds to a ~300 m grid (0.003° ≈ 333 m) for the public pin; same rule as the seed. */
const approx = (v: number) => Math.round(Math.round(v / 0.003) * 0.003 * 10000) / 10000;
const money = (paise: number | null) =>
  paise === null ? null : { paise, currency: "INR" as const };
const unprocessable = (issues: Issue[]) =>
  new HttpError("unprocessable", "Validation failed", issues);

// ── Hosts ──

/** POST /api/me/host: adds HOST, moves NOT_STARTED/REJECTED to PENDING, records the attestation. */
export async function becomeHost(user: CurrentUser): Promise<HostStatusResponse> {
  const status: HostVerificationStatus =
    user.hostVerificationStatus === "VERIFIED" ? "VERIFIED" : "PENDING";
  const roles = user.roles.includes("HOST") ? user.roles : [...user.roles, "HOST" as const];
  const [updated] = await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { roles, hostVerificationStatus: status },
      select: { roles: true, hostVerificationStatus: true },
    }),
    audit(user.id, "host.apply", "User", user.id, null, { attestAuthority: true }),
  ]);
  return updated;
}

/** Admin decision on host verification (called by T4.6). Returns the audit row id. */
export async function setHostVerification(
  adminId: string,
  userId: string,
  status: HostVerificationStatus,
  reason: string,
) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { roles: true } });
  if (!user) throw new HttpError("not_found", "User not found");
  const roles =
    status === "VERIFIED" && !user.roles.includes("HOST")
      ? [...user.roles, "HOST" as const]
      : user.roles;
  const [, log] = await db.$transaction([
    db.user.update({ where: { id: userId }, data: { hostVerificationStatus: status, roles } }),
    audit(adminId, "host.verification", "User", userId, reason, { status }),
  ]);
  return { auditLogId: log.id };
}

// ── Shapes ──

function photoDto(p: ListingRow["photos"][number]): ListingPhoto {
  return { id: p.id, url: p.url, position: p.position };
}

function publicFields(l: ListingRow, rating: Rating, policy: ActivePolicy) {
  return {
    id: l.id,
    title: l.title,
    description: l.description,
    locality: l.locality,
    city: l.city,
    approxLat: l.approxLat,
    approxLng: l.approxLng,
    spaceType: l.spaceType,
    vehicleTypes: l.vehicleTypes,
    maxHeightCm: l.maxHeightCm,
    maxWidthCm: l.maxWidthCm,
    maxLengthCm: l.maxLengthCm,
    covered: l.covered,
    lit: l.lit,
    evCharging: l.evCharging,
    security: l.security,
    hostRules: l.hostRules,
    prices: {
      hourly: money(l.hourlyPaise),
      daily: money(l.dailyPaise),
      weekly: money(l.weeklyPaise),
      monthly: money(l.monthlyPaise),
    },
    minDurationMinutes: l.minDurationMinutes,
    cancellationPolicy: {
      key: l.cancellationPolicy,
      summary: cancellationText(policy, l.cancellationPolicy),
    },
    photos: l.photos.filter((p) => p.moderationStatus !== "REJECTED").map(photoDto),
    // "verified" means the host passed ParkShare's host verification, nothing more (FR-11).
    host: {
      id: l.host.id,
      name: l.host.name,
      verified: l.host.hostVerificationStatus === "VERIFIED",
    },
    rating,
  };
}

async function ratingOf(listingId: string) {
  const r = await db.review.aggregate({
    where: { listingId, moderationStatus: "APPROVED" },
    _avg: { rating: true },
    _count: true,
  });
  return { average: r._avg.rating, count: r._count };
}

type Rating = { average: number | null; count: number };

function toOwned(
  l: ListingRow,
  policy: ActivePolicy,
  rating: Rating = { average: null, count: 0 },
): OwnedListing {
  return OwnedListing.parse({
    ...publicFields(l, rating, policy),
    photos: l.photos.map(photoDto),
    address: l.address,
    lat: l.lat,
    lng: l.lng,
    accessInstructions: l.accessInstructions,
    turnoverBufferMinutes: l.turnoverBufferMinutes,
    status: l.status,
    suspendedReason: l.suspendedReason,
    hostAttestedAt: l.hostAttestedAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  });
}

// ── Listings ──

async function loadOwned(id: string, user: CurrentUser) {
  const listing = await db.listing.findUnique({ where: { id }, include });
  if (!listing) throw new HttpError("not_found", "Listing not found");
  assertOwner(listing.hostId, user);
  return listing;
}

function checkPolicyKey(policy: ActivePolicy, key: string | undefined) {
  if (key !== undefined && !(key in policy.cancellationPolicy))
    throw unprocessable([{ path: ["cancellationPolicy"], message: "Unknown cancellation policy" }]);
}

/** Every reason a listing can't be public (FR-02 AC1/AC2); empty when publishable. */
async function publishIssues(l: ListingRow, policy: ActivePolicy): Promise<Issue[]> {
  const issues: Issue[] = [];
  if (l.title.trim().length < 3) issues.push({ path: ["title"], message: "Title is required" });
  if (l.description.trim().length < 10)
    issues.push({ path: ["description"], message: "Description is required" });
  const b = policy.cityBoundary;
  if (!(l.lat >= b.minLat && l.lat <= b.maxLat && l.lng >= b.minLng && l.lng <= b.maxLng))
    issues.push({ path: ["lat"], message: "Location must be inside the Pune service area" });
  if (!l.photos.some((p) => p.moderationStatus !== "REJECTED"))
    issues.push({ path: ["photos"], message: "Add at least one photo" });
  if (
    ![l.hourlyPaise, l.dailyPaise, l.weeklyPaise, l.monthlyPaise].some((p) => p !== null && p > 0)
  )
    issues.push({ path: ["prices"], message: "Offer at least one rental type with a price" });
  if ((await db.availabilityRule.count({ where: { listingId: l.id } })) === 0)
    issues.push({ path: ["availability"], message: "Add at least one availability rule" });
  if (!l.hostAttestedAt)
    issues.push({ path: ["attestAuthority"], message: "Attest your authority to rent this space" });
  return issues;
}

/** POST /api/listings: any host, verified or not, may create a DRAFT. */
export async function createListing(user: CurrentUser, body: CreateListingBody) {
  if (!user.roles.includes("HOST")) throw new HttpError("forbidden", "Become a host first");
  const policy = await getActivePolicy();
  checkPolicyKey(policy, body.cancellationPolicy);
  const { hourlyPaise, dailyPaise, weeklyPaise, monthlyPaise, ...rest } = body;
  const listing = await db.listing.create({
    data: {
      ...rest,
      hostId: user.id,
      approxLat: approx(body.lat),
      approxLng: approx(body.lng),
      hourlyPaise: hourlyPaise ?? null,
      dailyPaise: dailyPaise ?? null,
      weeklyPaise: weeklyPaise ?? null,
      monthlyPaise: monthlyPaise ?? null,
    },
    include,
  });
  return toOwned(listing, policy);
}

/**
 * PATCH /api/listings/:id. Never touches Booking rows: confirmed bookings keep the totals
 * and times they snapshotted, so edits can't silently change them (FR-02 AC3).
 */
export async function updateListing(user: CurrentUser, id: string, body: UpdateListingBody) {
  const current = await loadOwned(id, user);
  const policy = await getActivePolicy();
  checkPolicyKey(policy, body.cancellationPolicy);
  const data: Prisma.ListingUpdateInput = { ...body };
  if (body.lat !== undefined) data.approxLat = approx(body.lat);
  if (body.lng !== undefined) data.approxLng = approx(body.lng);
  if (current.status !== "PUBLISHED") {
    return toOwned(await db.listing.update({ where: { id }, data, include }), policy);
  }
  // Published: apply and re-validate atomically, so an invalid edit leaves nothing behind.
  const updated = await db.$transaction(async (tx) => {
    const l = await tx.listing.update({ where: { id }, data, include });
    const issues = await publishIssues(l, policy);
    if (issues.length) throw unprocessable(issues);
    return l;
  });
  return toOwned(updated, policy, await ratingOf(id));
}

/** GET /api/listings/mine */
export async function listMine(user: CurrentUser, limit: number, cursor?: string) {
  if (cursor && !Uuid.safeParse(cursor).success)
    throw new HttpError("validation_error", "Invalid cursor");
  const rows = await db.listing.findMany({
    where: { hostId: user.id },
    include,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const ratings = await db.review.groupBy({
    by: ["listingId"],
    where: { listingId: { in: page.map((l) => l.id) }, moderationStatus: "APPROVED" },
    _avg: { rating: true },
    _count: true,
  });
  const policy = await getActivePolicy();
  const byId = new Map(
    ratings.map((r) => [r.listingId, { average: r._avg.rating, count: r._count }]),
  );
  return {
    items: page.map((l) => toOwned(l, policy, byId.get(l.id))),
    nextCursor: more ? page.at(-1)!.id : null,
  };
}

/** GET /api/listings/:id. Only PUBLISHED is public; owner and admins see any status. */
export async function getPublicListing(id: string, viewer: CurrentUser | null) {
  const listing = await db.listing.findUnique({ where: { id }, include });
  const canSee =
    listing &&
    (listing.status === "PUBLISHED" ||
      viewer?.id === listing.hostId ||
      viewer?.roles.includes("ADMIN"));
  if (!canSee) throw new HttpError("not_found", "Listing not found");
  // Strict parse: a private field slipping in becomes a 500, never a leak (FR-03).
  return PublicListing.parse(publicFields(listing, await ratingOf(id), await getActivePolicy()));
}

/** POST /api/listings/:id/publish: owner, verified host (FR-01 AC2), all checks pass. */
export async function publishListing(user: CurrentUser, id: string, req: Request) {
  const listing = await loadOwned(id, user);
  await requireVerifiedHost(req);
  const policy = await getActivePolicy();
  if (listing.status === "PUBLISHED") return toOwned(listing, policy, await ratingOf(id));
  if (listing.status !== "DRAFT")
    throw new HttpError("conflict", `A ${listing.status} listing can't be published`);
  const issues = await publishIssues({ ...listing, hostAttestedAt: new Date() }, policy);
  if (issues.length) throw unprocessable(issues);
  // Moderation pre-review: PENDING_REVIEW is admin-triggered only; passing checks auto-publish.
  const updated = await db.listing.update({
    where: { id },
    data: { status: "PUBLISHED", hostAttestedAt: listing.hostAttestedAt ?? new Date() },
    include,
  });
  return toOwned(updated, policy);
}

/** Admin suspension (called by T4.6). Suspended listings drop out of public GET and search. */
export async function suspendListing(adminId: string, listingId: string, reason: string) {
  const [, log] = await db.$transaction([
    db.listing.update({
      where: { id: listingId },
      data: { status: "SUSPENDED", suspendedReason: reason },
    }),
    audit(adminId, "listing.suspend", "Listing", listingId, reason),
  ]);
  return { auditLogId: log.id };
}

// ── Photos ──

/** 404 if missing, 403 unless the caller owns it. */
export async function assertListingOwner(user: CurrentUser, id: string) {
  await loadOwned(id, user);
}

/** Attaches an uploaded asset; the publicId must sit in this listing's folder. */
export async function addPhoto(user: CurrentUser, id: string, publicId: string, position?: number) {
  const listing = await loadOwned(id, user);
  const folder = listingFolder(listing.id);
  if (!new RegExp(`^${folder}/[A-Za-z0-9_-]+$`).test(publicId))
    throw unprocessable([{ path: ["publicId"], message: "Photo does not belong to this listing" }]);
  if (listing.photos.length >= MAX_PHOTOS)
    throw unprocessable([{ path: ["photos"], message: `At most ${MAX_PHOTOS} photos` }]);
  const url = photoUrl(publicId);
  if (!url) return null;
  const next = Math.max(-1, ...listing.photos.map((p) => p.position)) + 1;
  const photo = await db.listingPhoto.create({
    data: { listingId: id, publicId, url, position: position ?? next, moderationStatus: "PENDING" },
  });
  return { id: photo.id, url: photo.url, position: photo.position };
}

async function photosOf(listingId: string) {
  const photos = await db.listingPhoto.findMany({
    where: { listingId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return { items: photos.map((p) => ({ id: p.id, url: p.url, position: p.position })) };
}

export async function deletePhoto(user: CurrentUser, id: string, photoId: string) {
  const listing = await loadOwned(id, user);
  if (!listing.photos.some((p) => p.id === photoId))
    throw new HttpError("not_found", "Photo not found");
  // ponytail: the Cloudinary asset stays; add a destroy call if storage cost matters.
  await db.$transaction(async (tx) => {
    await tx.listingPhoto.delete({ where: { id: photoId } });
    if (
      listing.status === "PUBLISHED" &&
      !(await tx.listingPhoto.count({
        where: { listingId: id, moderationStatus: { not: "REJECTED" } },
      }))
    )
      throw unprocessable([{ path: ["photos"], message: "A published listing needs a photo" }]);
  });
  return photosOf(id);
}

export async function reorderPhotos(user: CurrentUser, id: string, photoIds: string[]) {
  const listing = await loadOwned(id, user);
  const have = new Set(listing.photos.map((p) => p.id));
  if (
    photoIds.length !== have.size ||
    new Set(photoIds).size !== have.size ||
    !photoIds.every((p) => have.has(p))
  )
    throw unprocessable([
      { path: ["photoIds"], message: "List every photo of the listing exactly once" },
    ]);
  await db.$transaction(
    photoIds.map((photoId, position) =>
      db.listingPhoto.update({ where: { id: photoId }, data: { position } }),
    ),
  );
  return photosOf(id);
}

// ── Availability ──

function availabilityIssues(rules: AvailabilityRule[], exceptions: AvailabilityException[]) {
  const issues: Issue[] = [];
  rules.forEach((r, i) => {
    if (r.startMinute >= r.endMinute)
      issues.push({ path: ["rules", i], message: "startMinute must be before endMinute" });
  });
  for (let day = 0; day < 7; day++) {
    const sorted = rules
      .map((r, i) => ({ ...r, i }))
      .filter((r) => r.weekday === day)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let k = 1; k < sorted.length; k++)
      if (sorted[k].startMinute < sorted[k - 1].endMinute)
        issues.push({
          path: ["rules", sorted[k].i],
          message: "Overlaps another rule on the same weekday",
        });
  }
  exceptions.forEach((e, i) => {
    if (Date.parse(e.startAt) >= Date.parse(e.endAt))
      issues.push({ path: ["exceptions", i], message: "startAt must be before endAt" });
  });
  return issues;
}

/** POST /api/listings/:id/availability: replaces the weekly rules and the exceptions. */
export async function replaceAvailability(
  user: CurrentUser,
  id: string,
  rules: AvailabilityRule[],
  exceptions: AvailabilityException[],
): Promise<GetAvailabilityResponse> {
  const listing = await loadOwned(id, user);
  const issues = availabilityIssues(rules, exceptions);
  if (listing.status === "PUBLISHED" && rules.length === 0)
    issues.push({ path: ["rules"], message: "A published listing needs at least one rule" });
  if (issues.length) throw unprocessable(issues);
  await db.$transaction([
    db.availabilityRule.deleteMany({ where: { listingId: id } }),
    db.availabilityException.deleteMany({ where: { listingId: id } }),
    db.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, listingId: id })) }),
    db.availabilityException.createMany({
      data: exceptions.map((e) => ({
        listingId: id,
        startAt: new Date(e.startAt),
        endAt: new Date(e.endAt),
        unavailable: e.unavailable,
        reason: e.reason ?? null,
      })),
    }),
  ]);
  const busy = await db.booking.findMany({
    where: { listingId: id, status: { in: [...BLOCKING] }, blockedUntil: { gt: new Date() } },
    select: { startAt: true, blockedUntil: true },
    orderBy: { startAt: "asc" },
    take: 500,
  });
  return {
    listingId: id,
    timezone: "Asia/Kolkata",
    rules: [...rules].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute),
    exceptions: exceptions.map((e) => ({ ...e, reason: e.reason ?? null })),
    busy: busy.map((b) => ({
      startAt: b.startAt.toISOString(),
      endAt: b.blockedUntil.toISOString(),
    })),
  };
}
