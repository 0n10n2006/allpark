import {
  ListingCard,
  type SearchListingsQuery,
  type SearchListingsResponse,
  Uuid,
} from "@/contracts";
import { getActivePolicy } from "@/config/policy";
import { Prisma, type RentalType } from "@/generated/prisma/client";
import { BLOCKING_STATUSES, isWithinSchedule, monthlyTermEnd } from "@/server/availability/service";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { priceFor } from "@/server/pricing/calc";
import { listingRatingSummary } from "@/server/reviews";

// FR-03 search. One SQL query per batch does the area, filters, and the bulk booking
// conflict check; the schedule check (weekly hours, exceptions, minimum duration) then
// runs in memory through the availability service for that batch. Plan §2 Geo row.

const MAX_LIMIT = 50;
const MAX_RADIUS_M = 25_000;
const MAX_INTERVAL_MS = 400 * 24 * 3_600_000; // priceFor's cap
const M_PER_DEG_LAT = 111_320;
/**
 * approxLat/approxLng sit on a 0.003° grid, so within 0.0015° of the real point. The
 * indexed exact columns prefilter with this margin; the area test itself uses the
 * approximate ones, so probing viewport edges or radii can't pin down the real location.
 */
const APPROX_MARGIN = 0.0016;
/** Rows fetched per round when the schedule check may drop some. */
const BATCH = 100;
/** Per-request scan cap; past it the client gets a cursor to keep going. */
const MAX_SCAN = 1_000;

const BLOCKING_SQL = Prisma.join(BLOCKING_STATUSES.map((s) => Prisma.sql`${s}::"BookingStatus"`));

const PRICE_COLUMN: Record<RentalType, string> = {
  HOURLY: "hourlyPaise",
  DAILY: "dailyPaise",
  MULTI_DAY: "dailyPaise",
  WEEKLY: "weeklyPaise",
  MONTHLY: "monthlyPaise",
};

type Box = { minLat: number; maxLat: number; minLng: number; maxLng: number };

type Row = {
  id: string;
  title: string;
  locality: string;
  approxLat: number;
  approxLng: number;
  spaceType: ListingCard["spaceType"];
  vehicleTypes: ListingCard["vehicleTypes"];
  maxHeightCm: number | null;
  covered: boolean;
  hourlyPaise: number | null;
  dailyPaise: number | null;
  weeklyPaise: number | null;
  monthlyPaise: number | null;
  minDurationMinutes: number;
  dist: number;
  price: number;
};

const invalid = (message: string) => new HttpError("validation_error", message);

function encodeCursor(r: Row, sort: SearchListingsQuery["sort"]) {
  return Buffer.from(JSON.stringify([sort === "price" ? r.price : r.dist, r.id])).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): [number, string] {
  try {
    const [k, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Number.isFinite(k) && Uuid.safeParse(id).success) return [k, id];
  } catch {}
  throw invalid("Invalid cursor");
}

function intersect(a: Box, b: Box): Box | null {
  const box = {
    minLat: Math.max(a.minLat, b.minLat),
    maxLat: Math.min(a.maxLat, b.maxLat),
    minLng: Math.max(a.minLng, b.minLng),
    maxLng: Math.min(a.maxLng, b.maxLng),
  };
  return box.minLat <= box.maxLat && box.minLng <= box.maxLng ? box : null;
}

function interval(q: SearchListingsQuery) {
  if (!q.startAt) {
    if (q.endAt) throw invalid("endAt needs startAt");
    return null;
  }
  const startAt = new Date(q.startAt);
  if (!q.endAt && q.rentalType !== "MONTHLY") throw invalid("startAt needs endAt");
  // A monthly search gives only the start; the term runs to the same date next month.
  const endAt = q.endAt ? new Date(q.endAt) : monthlyTermEnd(startAt);
  const ms = endAt.getTime() - startAt.getTime();
  if (!(ms > 0)) throw invalid("endAt must be after startAt");
  if (ms > MAX_INTERVAL_MS) throw invalid("The search interval is too long");
  return { startAt, endAt };
}

/** GET /api/listings (FR-03): PUBLISHED listings in the area that pass every filter. */
export async function searchListings(q: SearchListingsQuery): Promise<SearchListingsResponse> {
  const limit = Math.min(q.limit, MAX_LIMIT);
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const when = interval(q);
  const policy = await getActivePolicy();

  const boxParts = [q.minLat, q.minLng, q.maxLat, q.maxLng];
  const hasBox = boxParts.some((v) => v !== undefined);
  if (hasBox && boxParts.some((v) => v === undefined))
    throw invalid("A viewport needs minLat, minLng, maxLat, and maxLng");
  if ((q.lat === undefined) !== (q.lng === undefined)) throw invalid("lat and lng go together");
  const centre = q.lat !== undefined ? { lat: q.lat, lng: q.lng! } : null;
  if (q.radiusMeters !== undefined && !centre) throw invalid("radiusMeters needs lat and lng");

  let area: Box | null = policy.cityBoundary;
  if (hasBox) {
    if (q.minLat! > q.maxLat! || q.minLng! > q.maxLng!) throw invalid("The viewport is inverted");
    area = intersect(area, {
      minLat: q.minLat!,
      maxLat: q.maxLat!,
      minLng: q.minLng!,
      maxLng: q.maxLng!,
    });
  }
  const radius = q.radiusMeters !== undefined ? Math.min(q.radiusMeters, MAX_RADIUS_M) : null;
  if (centre && radius !== null && area) {
    const dLat = radius / M_PER_DEG_LAT;
    const dLng = radius / (M_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180));
    area = intersect(area, {
      minLat: centre.lat - dLat,
      maxLat: centre.lat + dLat,
      minLng: centre.lng - dLng,
      maxLng: centre.lng + dLng,
    });
  }
  // Clamped to the city: a viewport outside Pune finds nothing.
  if (!area) return { items: [], nextCursor: null };

  // Distance (and the distance sort) is from the centre, else from the viewport's middle.
  const origin = centre ?? {
    lat: (area.minLat + area.maxLat) / 2,
    lng: (area.minLng + area.maxLng) / 2,
  };
  const priceSql = q.rentalType
    ? Prisma.raw(`l."${PRICE_COLUMN[q.rentalType]}"`)
    : Prisma.sql`LEAST(l."hourlyPaise", l."dailyPaise", l."weeklyPaise", l."monthlyPaise")`;

  const where: Prisma.Sql[] = [
    Prisma.sql`l.status = 'PUBLISHED'`,
    Prisma.sql`l.lat BETWEEN ${area.minLat - APPROX_MARGIN}::float8 AND ${area.maxLat + APPROX_MARGIN}::float8`,
    Prisma.sql`l.lng BETWEEN ${area.minLng - APPROX_MARGIN}::float8 AND ${area.maxLng + APPROX_MARGIN}::float8`,
    Prisma.sql`l."approxLat" BETWEEN ${area.minLat}::float8 AND ${area.maxLat}::float8`,
    Prisma.sql`l."approxLng" BETWEEN ${area.minLng}::float8 AND ${area.maxLng}::float8`,
    Prisma.sql`${priceSql} IS NOT NULL`,
  ];
  if (q.minPricePaise !== undefined) where.push(Prisma.sql`${priceSql} >= ${q.minPricePaise}::int`);
  if (q.maxPricePaise !== undefined) where.push(Prisma.sql`${priceSql} <= ${q.maxPricePaise}::int`);
  if (q.vehicleType)
    where.push(Prisma.sql`${q.vehicleType}::"VehicleType" = ANY(l."vehicleTypes")`);
  if (q.spaceTypes?.length)
    where.push(Prisma.sql`l."spaceType"::text = ANY(${q.spaceTypes}::text[])`);
  if (q.covered !== undefined) where.push(Prisma.sql`l.covered = ${q.covered}`);
  for (const [column, size] of [
    ["maxHeightCm", q.minHeightCm],
    ["maxWidthCm", q.minWidthCm],
    ["maxLengthCm", q.minLengthCm],
  ] as const)
    if (size !== undefined)
      where.push(
        Prisma.sql`(${Prisma.raw(`l."${column}"`)} IS NULL OR ${Prisma.raw(`l."${column}"`)} >= ${size}::int)`,
      );
  for (const flag of q.amenities ?? []) where.push(Prisma.raw(`l."${flag}"`));
  if (when)
    // Same predicate and range as findConflicts/createHold: the requested interval plus
    // this listing's turnover buffer; holds past holdExpiresAt don't block (FR-04 AC5:
    // monthly terms are ordinary inventory rows, so they block short-term searches).
    where.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "Booking" b
      WHERE b."listingId" = l.id
        AND b.status IN (${BLOCKING_SQL})
        AND NOT (b.status = 'PENDING_PAYMENT' AND b."holdExpiresAt" < now())
        AND b."blockedRange" && tstzrange(
          ${when.startAt}::timestamptz,
          ${when.endAt}::timestamptz + l."turnoverBufferMinutes" * interval '1 minute',
          '[)'))`);

  const distSql = Prisma.sql`2 * 6371000 * asin(LEAST(1, sqrt(
    power(sin(radians(l."approxLat" - ${origin.lat}::float8) / 2), 2) +
    cos(radians(${origin.lat}::float8)) * cos(radians(l."approxLat")) *
    power(sin(radians(l."approxLng" - ${origin.lng}::float8) / 2), 2))))`;
  const keySql = Prisma.raw(q.sort === "price" ? "price" : "dist");
  const batch = when ? BATCH : limit + 1;

  const query = (cursor: [number, string] | null) => {
    const outer: Prisma.Sql[] = [];
    if (centre && radius !== null) outer.push(Prisma.sql`dist <= ${radius}::float8`);
    if (cursor)
      outer.push(Prisma.sql`(${keySql}, id) > (${cursor[0]}::float8, ${cursor[1]}::uuid)`);
    return Prisma.sql`
      SELECT * FROM (
        SELECT l.id, l.title, l.locality, l."approxLat", l."approxLng", l."spaceType",
               l."vehicleTypes"::text[] AS "vehicleTypes", l."maxHeightCm", l.covered, l."hourlyPaise", l."dailyPaise",
               l."weeklyPaise", l."monthlyPaise", l."minDurationMinutes",
               ${distSql} AS dist, ${priceSql} AS price
        FROM "Listing" l
        WHERE ${Prisma.join(where, " AND ")}
      ) s
      ${outer.length ? Prisma.sql`WHERE ${Prisma.join(outer, " AND ")}` : Prisma.empty}
      ORDER BY ${keySql}, id
      LIMIT ${batch}`;
  };

  const out: Row[] = [];
  let last: Row | null = null;
  let exhausted = false;
  let cursor = after;
  scan: for (let scanned = 0; scanned < MAX_SCAN;) {
    const rows = await db.$queryRaw<Row[]>(query(cursor));
    scanned += rows.length;
    const open = when ? await openListings(rows, when, q.rentalType) : null;
    for (const r of rows) {
      if (!open || open.has(r.id)) {
        if (out.length === limit) break scan;
        out.push(r);
      }
      last = r;
    }
    if (rows.length < batch) {
      exhausted = true;
      break;
    }
    cursor = [q.sort === "price" ? last!.price : last!.dist, last!.id];
  }

  return {
    items: await toCards(out, centre !== null, when, q.rentalType, policy),
    nextCursor: exhausted || !last ? null : encodeCursor(last, q.sort),
  };
}

/** Ids of rows whose schedule covers the interval, via the availability service. */
async function openListings(
  rows: Row[],
  when: { startAt: Date; endAt: Date },
  rentalType: RentalType | undefined,
) {
  if (!rows.length) return new Set<string>();
  const listings = await db.listing.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    include: {
      availabilityRules: true,
      exceptions: { where: { startAt: { lt: when.endAt }, endAt: { gt: when.startAt } } },
    },
  });
  return new Set(
    listings
      .filter((l) => isWithinSchedule(l, when.startAt, when.endAt, rentalType))
      .map((l) => l.id),
  );
}

async function toCards(
  rows: Row[],
  hasCentre: boolean,
  when: { startAt: Date; endAt: Date } | null,
  rentalType: RentalType | undefined,
  policy: Awaited<ReturnType<typeof getActivePolicy>>,
): Promise<ListingCard[]> {
  const ids = rows.map((r) => r.id);
  const [photos, ratingOf] = await Promise.all([
    db.listingPhoto.findMany({
      where: { listingId: { in: ids }, moderationStatus: { not: "REJECTED" } },
      orderBy: [{ listingId: "asc" }, { position: "asc" }, { createdAt: "asc" }],
      distinct: ["listingId"],
      select: { listingId: true, url: true },
    }),
    listingRatingSummary(ids),
  ]);
  const photoOf = new Map(photos.map((p) => [p.listingId, p.url]));
  return rows.map((r) => {
    // ponytail: the price sort uses the unit price; for WEEKLY intervals with leftover
    // days the interval total can order slightly differently. Sort in SQL by total if it matters.
    const paise =
      when && rentalType
        ? priceFor(r, rentalType, when.startAt, when.endAt, policy).totalPaise
        : Number(r.price);
    // Strict parse: only card fields leave the server, never exact coords or the address.
    return ListingCard.parse({
      id: r.id,
      title: r.title,
      locality: r.locality,
      approxLat: r.approxLat,
      approxLng: r.approxLng,
      spaceType: r.spaceType,
      vehicleTypes: r.vehicleTypes,
      maxHeightCm: r.maxHeightCm,
      covered: r.covered,
      photoUrl: photoOf.get(r.id) ?? null,
      priceFrom: { paise: paise, currency: "INR" },
      distanceMeters: hasCentre ? Math.round(r.dist) : null,
      rating: ratingOf.get(r.id) ?? { average: null, count: 0 },
    });
  });
}
