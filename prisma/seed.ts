// Pune development seed. Idempotent: every row has a deterministic UUID and is upserted,
// and child rows (rules, photos) are replaced per listing.
import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  type Prisma,
  type SpaceType,
  type VehicleType,
} from "../src/generated/prisma/client";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** Stable UUID from a seed name, so re-running updates rows instead of duplicating them. */
function sid(name: string) {
  const h = createHash("sha1").update(`parkshare-seed:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const now = new Date();
const MIN = 60_000;

// Plan §2.2 placeholder defaults. src/config/policy.ts (T2.2) is the code-side source.
const POLICY_V1 = {
  commissionBps: 1000,
  renterFeeBps: 0,
  holdTtlMinutes: 10,
  gracePeriodMinutes: 10,
  reminderOffsetsMinutes: [30, 10],
  overstayFeeEnabled: false,
  cancellationPolicy: {
    standard: {
      HOURLY: [
        { minHoursBefore: 2, refundBps: 10000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      DAILY: [
        { minHoursBefore: 24, refundBps: 10000 },
        { minHoursBefore: 2, refundBps: 5000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      MULTI_DAY: [
        { minHoursBefore: 48, refundBps: 10000 },
        { minHoursBefore: 24, refundBps: 5000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      WEEKLY: [
        { minHoursBefore: 72, refundBps: 10000 },
        { minHoursBefore: 24, refundBps: 5000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      MONTHLY: [
        { minHoursBefore: 168, refundBps: 10000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
    },
  },
  monthlyRenewalReminderDays: 7,
  unpaidGraceDays: 0,
  payoutMode: "MANUAL",
  cityBoundary: { minLat: 18.4, maxLat: 18.7, minLng: 73.7, maxLng: 74.05 },
};

// Approximate locality centres; `premium` scales prices (1 = baseline).
const LOCALITIES = [
  { name: "Koregaon Park", lat: 18.5362, lng: 73.894, premium: 1.4 },
  { name: "Baner", lat: 18.559, lng: 73.7868, premium: 1.15 },
  { name: "Hinjewadi", lat: 18.5913, lng: 73.7389, premium: 1.0 },
  { name: "Viman Nagar", lat: 18.5679, lng: 73.9143, premium: 1.25 },
  { name: "Kothrud", lat: 18.5074, lng: 73.8077, premium: 1.0 },
  { name: "Shivajinagar", lat: 18.5308, lng: 73.8475, premium: 1.3 },
  { name: "Hadapsar", lat: 18.5089, lng: 73.926, premium: 0.9 },
  { name: "Aundh", lat: 18.558, lng: 73.8075, premium: 1.1 },
  { name: "Wakad", lat: 18.5987, lng: 73.761, premium: 0.9 },
  { name: "Camp", lat: 18.5155, lng: 73.879, premium: 1.2 },
] as const;

const SPACES: { type: SpaceType; label: string; covered: boolean }[] = [
  { type: "STILT", label: "Society stilt parking", covered: true },
  { type: "OPEN", label: "Open compound bay", covered: false },
  { type: "BASEMENT", label: "Basement slot", covered: true },
  { type: "DRIVEWAY", label: "Bungalow driveway", covered: false },
  { type: "GARAGE", label: "Private garage", covered: true },
];
const CAR_TYPES: VehicleType[] = ["HATCHBACK", "SEDAN", "SUV"];

/** Rounds to a ~300 m grid (0.003° latitude ≈ 333 m) for the public pin. */
const approx = (v: number) => Math.round(Math.round(v / 0.003) * 0.003 * 10000) / 10000;
/** Rounds paise to the nearest ₹5 (500 paise). */
const roundPaise = (p: number) => Math.round(p / 500) * 500;

async function upsertUser(key: string, data: Prisma.UserCreateInput) {
  const id = sid(`user:${key}`);
  return db.user.upsert({ where: { id }, create: { ...data, id }, update: data });
}

async function main() {
  const policy = await db.policyVersion.upsert({
    where: { version: 1 },
    create: { id: sid("policy:1"), version: 1, policy: POLICY_V1, effectiveAt: new Date(0) },
    update: { policy: POLICY_V1 },
  });

  const verified = { emailVerified: now, phoneVerifiedAt: now };
  await upsertUser("admin", {
    name: "ParkShare Admin",
    email: "admin@parkshare.local",
    phone: "+919800000001",
    roles: ["ADMIN", "RENTER"],
    ...verified,
  });

  const hostNames = [
    "Anjali Deshpande",
    "Rohit Kulkarni",
    "Sneha Joshi",
    "Vikram Patil",
    "Meera Gokhale",
  ];
  const hosts = [];
  for (const [i, name] of hostNames.entries()) {
    hosts.push(
      await upsertUser(`host:${i}`, {
        name,
        email: `host${i + 1}@parkshare.local`,
        phone: `+91980000010${i}`,
        roles: ["HOST", "RENTER"],
        hostVerificationStatus: "VERIFIED",
        payoutOnboardedAt: now,
        ...verified,
      }),
    );
  }
  const unverifiedHost = await upsertUser("host:unverified", {
    name: "Kunal Shinde",
    email: "host.unverified@parkshare.local",
    roles: ["HOST", "RENTER"],
    hostVerificationStatus: "PENDING",
    emailVerified: now,
  });

  const renterSpecs = [
    {
      name: "Aditya Rao",
      vehicles: [{ reg: "MH12AB1234", type: "HATCHBACK", h: 152, w: 168, l: 380 }],
    },
    {
      name: "Priya Nair",
      vehicles: [
        { reg: "MH14CD5678", type: "SUV", h: 178, w: 186, l: 460 },
        { reg: "MH12EF9012", type: "TWO_WHEELER", h: 110, w: 75, l: 200 },
      ],
    },
    {
      name: "Farhan Shaikh",
      vehicles: [{ reg: "MH12GH3456", type: "SEDAN", h: 148, w: 175, l: 445 }],
    },
  ] as const;
  const renters = [];
  for (const [i, spec] of renterSpecs.entries()) {
    const renter = await upsertUser(`renter:${i}`, {
      name: spec.name,
      email: `renter${i + 1}@parkshare.local`,
      phone: `+91980000020${i}`,
      roles: ["RENTER"],
      ...verified,
    });
    const vehicleIds = [];
    for (const v of spec.vehicles) {
      const id = sid(`vehicle:${v.reg}`);
      const data = {
        userId: renter.id,
        registration: v.reg,
        type: v.type,
        heightCm: v.h,
        widthCm: v.w,
        lengthCm: v.l,
      };
      await db.vehicle.upsert({ where: { id }, create: { ...data, id }, update: data });
      vehicleIds.push(id);
    }
    renters.push({ ...renter, vehicleIds });
  }

  // 50 published listings: 5 per locality.
  const listings: { id: string; hourlyPaise: number; turnover: number }[] = [];
  let n = 0;
  for (const loc of LOCALITIES) {
    for (let j = 0; j < 5; j++, n++) {
      const space = SPACES[j];
      // Deterministic spread of up to ~±1.2 km around the locality centre.
      const lat = +(loc.lat + (((n * 37) % 23) - 11) * 0.001).toFixed(6);
      const lng = +(loc.lng + (((n * 53) % 23) - 11) * 0.001).toFixed(6);
      const hourly = roundPaise((2000 + j * 1000) * loc.premium); // ₹20–₹80/h
      const offersMonthly = j !== 3;
      const listing = await upsertListing(`pub:${n}`, {
        hostId: hosts[n % hosts.length].id,
        title: `${space.label} near ${loc.name}`,
        description: `${space.label} in ${loc.name}, Pune. Easy access from the main road; ideal for daily commuters.`,
        address: `${10 + n}, Lane ${1 + (n % 7)}, ${loc.name}, Pune, Maharashtra 4110${String(n % 60).padStart(2, "0")}`,
        locality: loc.name,
        lat,
        lng,
        approxLat: approx(lat),
        approxLng: approx(lng),
        spaceType: space.type,
        vehicleTypes:
          j === 1 ? ["TWO_WHEELER", ...CAR_TYPES] : j === 2 ? ["HATCHBACK", "SEDAN"] : CAR_TYPES,
        maxHeightCm: space.type === "BASEMENT" || space.type === "STILT" ? 210 : null,
        maxLengthCm: space.type === "GARAGE" ? 480 : null,
        covered: space.covered,
        lit: j !== 3,
        evCharging: n % 6 === 0,
        security: space.type !== "DRIVEWAY",
        accessInstructions: `Show booking code to the guard at Gate ${1 + (n % 3)}. Slot ${String.fromCharCode(65 + j)}-${n + 1}.`,
        hostRules: "No overnight washing. Do not block neighbouring slots.",
        hourlyPaise: hourly,
        dailyPaise: roundPaise(hourly * 8),
        weeklyPaise: roundPaise(hourly * 40),
        monthlyPaise: offersMonthly ? roundPaise(hourly * 130) : null,
        minDurationMinutes: 60,
        turnoverBufferMinutes: j === 3 ? 15 : 0,
        hostAttestedAt: now,
        status: "PUBLISHED",
      });
      // Alternate between 24×7 and 07:00–22:00 Mon–Sat.
      await replaceRules(listing.id, n % 2 === 0);
      await replacePhotos(listing.id, `${loc.name} ${j + 1}`, 2 + (n % 2), "APPROVED");
      listings.push({
        id: listing.id,
        hourlyPaise: hourly,
        turnover: listing.turnoverBufferMinutes,
      });
    }
  }

  const draftBase = {
    description: "Covered slot in a gated society. Details still being filled in.",
    spaceType: "STILT" as const,
    vehicleTypes: CAR_TYPES,
    covered: true,
    hourlyPaise: 3000,
    dailyPaise: 20000,
  };
  for (const [k, loc] of [LOCALITIES[1], LOCALITIES[4]].entries()) {
    await upsertListing(`draft:${k}`, {
      ...draftBase,
      hostId: unverifiedHost.id,
      title: `Draft: stilt parking in ${loc.name}`,
      address: `${200 + k}, ${loc.name}, Pune`,
      locality: loc.name,
      lat: loc.lat,
      lng: loc.lng,
      approxLat: approx(loc.lat),
      approxLng: approx(loc.lng),
      status: "DRAFT",
    });
  }
  const camp = LOCALITIES[9];
  const suspended = await upsertListing("suspended:0", {
    ...draftBase,
    hostId: hosts[0].id,
    title: "Open bay near Camp (suspended)",
    address: `300, M.G. Road, ${camp.name}, Pune`,
    locality: camp.name,
    lat: camp.lat,
    lng: camp.lng,
    approxLat: approx(camp.lat),
    approxLng: approx(camp.lng),
    hostAttestedAt: now,
    status: "SUSPENDED",
    suspendedReason: "Reported: space not available on arrival (under review).",
  });
  await replacePhotos(suspended.id, "Camp suspended", 1, "APPROVED");

  // A few CONFIRMED hourly bookings, each on its own listing, starting tomorrow at 10:00 IST.
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 4, 30),
  );
  for (let k = 0; k < 4; k++) {
    const listing = listings[k * 7];
    const renter = renters[k % renters.length];
    const hours = 2 + k;
    const startAt = new Date(tomorrow.getTime() + k * 24 * 60 * MIN);
    const endAt = new Date(startAt.getTime() + hours * 60 * MIN);
    const subtotal = listing.hourlyPaise * hours;
    const commission = Math.round((subtotal * POLICY_V1.commissionBps) / 10000);
    const id = sid(`booking:${k}`);
    const data = {
      listingId: listing.id,
      renterId: renter.id,
      vehicleId: renter.vehicleIds[0],
      rentalType: "HOURLY" as const,
      startAt,
      endAt,
      blockedUntil: new Date(endAt.getTime() + listing.turnover * MIN),
      status: "CONFIRMED" as const,
      subtotalPaise: subtotal,
      commissionPaise: commission,
      hostEarningsPaise: subtotal - commission,
      totalPaise: subtotal,
    };
    await db.booking.upsert({ where: { id }, create: { ...data, id }, update: data });
  }

  const counts = await db.listing.groupBy({ by: ["status"], _count: true });
  console.log(
    `Seeded policy v${policy.version}; listings:`,
    counts.map((c) => `${c.status}=${c._count}`).join(" "),
  );
}

async function upsertListing(key: string, data: Prisma.ListingUncheckedCreateInput) {
  const id = sid(`listing:${key}`);
  return db.listing.upsert({ where: { id }, create: { ...data, id }, update: data });
}

async function replaceRules(listingId: string, allDay: boolean) {
  await db.availabilityRule.deleteMany({ where: { listingId } });
  const days = allDay ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6];
  await db.availabilityRule.createMany({
    data: days.map((weekday) => ({
      listingId,
      weekday,
      startMinute: allDay ? 0 : 7 * 60,
      endMinute: allDay ? 1440 : 22 * 60,
    })),
  });
}

async function replacePhotos(
  listingId: string,
  label: string,
  count: number,
  moderationStatus: "APPROVED" | "PENDING",
) {
  await db.listingPhoto.deleteMany({ where: { listingId } });
  await db.listingPhoto.createMany({
    data: Array.from({ length: count }, (_, position) => ({
      listingId,
      position,
      moderationStatus,
      url: `https://placehold.co/800x600/png?text=${encodeURIComponent(`${label} #${position + 1}`)}`,
    })),
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
