// Inserts N PUBLISHED listings around Pune (with schedules, photos, and bookings) for the
// search p95 check (FR-03, PRD §9). Set-based SQL, so 5,000 rows take seconds.
// Run: npx tsx scripts/seed-search-perf.ts [count]   (reads DATABASE_URL, loading .env if present)
// Re-running replaces the previous perf rows (they all belong to one perf host).
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";

const HOST_EMAIL = "perf-host@parkshare.test";
const RENTER_EMAIL = "perf-renter@parkshare.test";

export async function seedSearchPerf(db: PrismaClient, count = 5_000) {
  const host = await db.user.upsert({
    where: { email: HOST_EMAIL },
    create: {
      email: HOST_EMAIL,
      name: "Perf host",
      roles: ["HOST"],
      hostVerificationStatus: "VERIFIED",
    },
    update: {},
  });
  const renter = await db.user.upsert({
    where: { email: RENTER_EMAIL },
    create: { email: RENTER_EMAIL, name: "Perf renter" },
    update: {},
  });
  await db.booking.deleteMany({ where: { listing: { hostId: host.id } } });
  await db.listing.deleteMany({ where: { hostId: host.id } });

  // Spread over the Pune box; approx* follows the 0.003° grid rule used for real listings.
  await db.$executeRaw`
    INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
      "approxLat", "approxLng", "spaceType", "vehicleTypes", "maxHeightCm", covered, lit,
      "evCharging", security, "hourlyPaise", "dailyPaise", "weeklyPaise", "monthlyPaise",
      "minDurationMinutes", "turnoverBufferMinutes", status, "hostAttestedAt", "updatedAt")
    SELECT ${host.id}::uuid, 'Perf listing ' || i, 'Seeded for the search perf test.',
      'Perf address ' || i, 'Perf', lat, lng,
      round(round(lat / 0.003) * 0.003 * 10000) / 10000,
      round(round(lng / 0.003) * 0.003 * 10000) / 10000,
      (ARRAY['DRIVEWAY','GARAGE','STILT','OPEN']::"SpaceType"[])[1 + i % 4],
      CASE WHEN i % 3 = 0 THEN ARRAY['SEDAN','SUV']::"VehicleType"[] ELSE ARRAY['HATCHBACK','SEDAN']::"VehicleType"[] END,
      CASE WHEN i % 4 = 0 THEN NULL ELSE 170 + (i % 6) * 10 END,
      i % 2 = 0, i % 3 = 0, i % 7 = 0, i % 5 = 0,
      CASE WHEN i % 10 = 9 THEN NULL ELSE 2000 + (i * 37) % 8000 END,
      15000 + (i * 53) % 30000,
      CASE WHEN i % 2 = 0 THEN 80000 + (i * 71) % 100000 END,
      CASE WHEN i % 3 <> 2 THEN 250000 + (i * 97) % 400000 END,
      60, (i % 3) * 15, 'PUBLISHED', now(), now()
    FROM (
      SELECT i, 18.42 + random() * 0.26 AS lat, 73.72 + random() * 0.31 AS lng
      FROM generate_series(1, ${count}::int) i
    ) g`;

  const listings = perfListings(host.id);
  // 80% open 24x7, the rest 08:00–20:00 Monday to Saturday.
  await db.$executeRaw`
    INSERT INTO "AvailabilityRule" ("listingId", weekday, "startMinute", "endMinute", "updatedAt")
    SELECT l.id, d, CASE WHEN l.n % 5 = 0 THEN 480 ELSE 0 END, CASE WHEN l.n % 5 = 0 THEN 1200 ELSE 1440 END, now()
    FROM (${listings}) l CROSS JOIN generate_series(0, 6) d
    WHERE NOT (l.n % 5 = 0 AND d = 0)`;
  await db.$executeRaw`
    INSERT INTO "ListingPhoto" ("listingId", url, position, "moderationStatus", "updatedAt")
    SELECT l.id, 'https://res.cloudinary.com/demo/image/upload/sample.jpg', 0, 'APPROVED', now()
    FROM (${listings}) l`;
  // Every 20th listing has a monthly term from today; the others have two short bookings
  // two days apart in the next week (never overlapping, so the exclusion constraint holds).
  await db.$executeRaw`
    INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt", "blockedUntil",
      status, "subtotalPaise", "commissionPaise", "hostEarningsPaise", "totalPaise", "updatedAt")
    SELECT l.id, ${renter.id}::uuid, 'MONTHLY'::"RentalType", date_trunc('day', now()),
      date_trunc('day', now()) + interval '1 month', date_trunc('day', now()) + interval '1 month',
      'CONFIRMED'::"BookingStatus", 300000, 30000, 270000, 300000, now()
    FROM (${listings}) l WHERE l.n % 20 = 0
    UNION ALL
    SELECT l.id, ${renter.id}::uuid, 'HOURLY'::"RentalType", s, s + interval '2 hours', s + interval '2 hours',
      'CONFIRMED'::"BookingStatus", 10000, 1000, 9000, 10000, now()
    FROM (${listings}) l
    CROSS JOIN generate_series(0, 1) k
    CROSS JOIN LATERAL (SELECT date_trunc('hour', now()) + k * interval '2 days'
                               + ((l.n * 7 + k * 5) % 20) * interval '1 hour' AS s) t
    WHERE l.n % 20 <> 0`;
  for (const t of ["Listing", "Booking", "AvailabilityRule", "ListingPhoto"])
    await db.$executeRawUnsafe(`ANALYZE "${t}"`);
  return { hostId: host.id, count };
}

/** The perf host's listings, numbered 1..n in a stable order. */
function perfListings(hostId: string) {
  return Prisma.sql`SELECT id, row_number() OVER (ORDER BY title) AS n FROM "Listing" WHERE "hostId" = ${hostId}::uuid`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.loadEnvFile();
  } catch {}
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed perf data with NODE_ENV=production");
    process.exit(1);
  }
  void (async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL!,
        options: "-c TimeZone=UTC",
      }),
    });
    const count = Number(process.argv[2] ?? 5_000);
    const t = Date.now();
    const r = await seedSearchPerf(db, count);
    console.log(`Seeded ${r.count} perf listings in ${Date.now() - t} ms`);
    await db.$disconnect();
  })();
}
