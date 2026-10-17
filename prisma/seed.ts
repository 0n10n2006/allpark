// Pune development and demo seed. Idempotent: every row has a deterministic UUID and is upserted,
// and child rows (rules, photos) are replaced per listing.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  type Prisma,
  type SpaceType,
  type VehicleType,
} from "../src/generated/prisma/client";

const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    // adapter-pg sends Dates as UTC text without an offset: pin the session to UTC.
    options: "-c TimeZone=UTC",
  }),
});

/** Stable UUID from a seed name, so re-running updates rows instead of duplicating them. */
function sid(name: string) {
  const h = createHash("sha1").update(`parkshare-seed:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const now = new Date();
const MIN = 60_000;

// CRC32 calculation for local zero-dependency PNG generation
function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ -1) >>> 0;
}

/** Pure Node PNG generator (no network, no dependencies) */
function makePng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const rowSize = 1 + width * 3;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter: none
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 3;
      const isBorder = x < 6 || x >= width - 6 || y < 6 || y >= height - 6;
      const isLine = Math.abs(x - Math.floor(width / 2)) < 3 || Math.abs(y - Math.floor(height / 2)) < 3;
      if (isBorder || isLine) {
        rawData[pxOffset] = 240;
        rawData[pxOffset + 1] = 240;
        rawData[pxOffset + 2] = 240;
      } else {
        rawData[pxOffset] = r;
        rawData[pxOffset + 1] = g;
        rawData[pxOffset + 2] = b;
      }
    }
  }

  const deflated = deflateSync(rawData);

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdrData),
    chunk("IDAT", deflated),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Generates local placeholder PNGs in public/uploads/seed/ */
function ensureSeedPhotos() {
  const seedDir = join(process.cwd(), "public", "uploads", "seed");
  mkdirSync(seedDir, { recursive: true });
  const palettes = [
    [41, 128, 185],  // Blue
    [39, 174, 96],   // Green
    [211, 84, 0],    // Amber
    [142, 68, 173],  // Purple
    [22, 160, 133],  // Teal
  ];
  for (let i = 0; i < palettes.length; i++) {
    const [r, g, b] = palettes[i];
    const png = makePng(400, 300, r, g, b);
    writeFileSync(join(seedDir, `parking-${i + 1}.png`), png);
  }
}

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
  if (data.email) {
    const existing = await db.user.findFirst({
      where: { OR: [{ id }, { email: data.email }] },
    });
    if (existing) {
      return db.user.update({
        where: { id: existing.id },
        data,
      });
    }
  }
  return db.user.upsert({ where: { id }, create: { ...data, id }, update: data });
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
  isDemo: boolean,
) {
  const authBase = process.env.AUTH_URL || "http://localhost:3000";
  await db.listingPhoto.deleteMany({ where: { listingId } });
  await db.listingPhoto.createMany({
    data: Array.from({ length: count }, (_, position) => ({
      listingId,
      position,
      moderationStatus,
      url: isDemo
        ? `${authBase}/uploads/seed/parking-${((position % 5) + 1)}.png`
        : `https://placehold.co/800x600/png?text=${encodeURIComponent(`${label} #${position + 1}`)}`,
    })),
  });
}

async function main() {
  const isDemo = process.env.DEMO_MODE === "1";
  console.log(`Starting ParkShare seed (mode: ${isDemo ? "DEMO" : "DEV"})...`);

  const policy = await db.policyVersion.upsert({
    where: { version: 1 },
    create: { id: sid("policy:1"), version: 1, policy: POLICY_V1, effectiveAt: new Date(0) },
    update: { policy: POLICY_V1 },
  });

  const verified = { emailVerified: now, phoneVerifiedAt: now };

  // 1. Core / Demo accounts
  await upsertUser("asha", {
    name: "Asha Sharma",
    email: "asha@parkshare.local",
    phone: "+919800000010",
    roles: ["ADMIN", "RENTER"],
    ...verified,
  });

  // Standard admin alias
  await upsertUser("admin", {
    name: "ParkShare Admin",
    email: "admin@parkshare.local",
    phone: "+919800000001",
    roles: ["ADMIN", "RENTER"],
    ...verified,
  });

  const harsh = await upsertUser("harsh", {
    name: "Harsh Vardhan",
    email: "harsh@parkshare.local",
    phone: "+919800000020",
    roles: ["HOST", "RENTER"],
    hostVerificationStatus: "VERIFIED",
    payoutOnboardedAt: now,
    ...verified,
  });

  const newhost = await upsertUser("newhost", {
    name: "Naveen Host",
    email: "newhost@parkshare.local",
    phone: "+919800000030",
    roles: ["HOST", "RENTER"],
    hostVerificationStatus: "PENDING",
    emailVerified: now,
  });

  const riya = await upsertUser("riya", {
    name: "Riya Sen",
    email: "riya@parkshare.local",
    phone: "+919800000040",
    roles: ["RENTER"],
    ...verified,
  });

  // Seed Riya's primary vehicle
  const riyaVehicleId = sid("vehicle:riya:1");
  await db.vehicle.upsert({
    where: { id: riyaVehicleId },
    create: {
      id: riyaVehicleId,
      userId: riya.id,
      registration: "MH12RS1001",
      type: "HATCHBACK",
      heightCm: 150,
      widthCm: 170,
      lengthCm: 385,
    },
    update: {
      userId: riya.id,
      registration: "MH12RS1001",
      type: "HATCHBACK",
      heightCm: 150,
      widthCm: 170,
      lengthCm: 385,
    },
  });

  // Standard dev hosts / renters for non-demo dev runs
  const devHosts = [harsh];
  if (!isDemo) {
    const hostNames = ["Anjali Deshpande", "Rohit Kulkarni", "Sneha Joshi", "Vikram Patil"];
    for (const [i, name] of hostNames.entries()) {
      devHosts.push(
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
  }

  if (isDemo) {
    ensureSeedPhotos();
    await db.dispute.deleteMany({});
    await db.overstayIncident.deleteMany({});
    await db.review.deleteMany({});
    await db.report.deleteMany({});
    await db.sessionEvent.deleteMany({});
    await db.ledgerEntry.deleteMany({});
    await db.refund.deleteMany({});
    await db.payment.deleteMany({});
    await db.booking.deleteMany({});
    await db.monthlyAgreement.deleteMany({});
    await db.priceQuote.deleteMany({});
    await db.listingPhoto.deleteMany({});
    await db.availabilityRule.deleteMany({});
    await db.listing.deleteMany({});
  }

  // 2. Published listings
  // Demo mode: ~30 Pune listings (3 per locality across 10 localities), all hosted by Harsh
  // Dev mode: 50 listings (5 per locality)
  const countPerLocality = isDemo ? 3 : 5;
  const listings: { id: string; title: string; hourlyPaise: number; turnover: number; locality: string }[] = [];
  let n = 0;

  for (const loc of LOCALITIES) {
    for (let j = 0; j < countPerLocality; j++, n++) {
      const space = SPACES[j % SPACES.length];
      const lat = +(loc.lat + (((n * 37) % 23) - 11) * 0.001).toFixed(6);
      const lng = +(loc.lng + (((n * 53) % 23) - 11) * 0.001).toFixed(6);
      const hourly = roundPaise((2000 + (j % 5) * 1000) * loc.premium); // ₹20–₹80/h
      const offersMonthly = j !== 3;
      const hostId = isDemo ? harsh.id : devHosts[n % devHosts.length].id;
      const title = `${space.label} near ${loc.name}`;

      const listing = await upsertListing(`pub:${n}`, {
        hostId,
        title,
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
        accessInstructions: `Show booking code to the guard at Gate ${1 + (n % 3)}. Slot ${String.fromCharCode(65 + (j % 5))}-${n + 1}.`,
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

      await replaceRules(listing.id, n % 2 === 0);
      await replacePhotos(listing.id, `${loc.name} ${j + 1}`, 2 + (n % 2), "APPROVED", isDemo);
      listings.push({
        id: listing.id,
        title,
        hourlyPaise: hourly,
        turnover: listing.turnoverBufferMinutes,
        locality: loc.name,
      });
    }
  }

  // 3. Draft listings by unverified host Naveen
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
      hostId: newhost.id,
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

  // 4. Suspended listing
  const camp = LOCALITIES[9];
  const suspended = await upsertListing("suspended:0", {
    ...draftBase,
    hostId: harsh.id,
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
  await replacePhotos(suspended.id, "Camp suspended", 1, "APPROVED", isDemo);

  // 5. Rich Bookings for Riya in interesting states
  console.log("Seeding rich demo bookings across lifecycle states...");

  // Helper for deterministic booking + payment + ledger creation
  async function seedBooking(
    key: string,
    spec: {
      listingIdx: number;
      rentalType: "HOURLY" | "DAILY" | "MONTHLY";
      status: "CONFIRMED" | "ACTIVE" | "GRACE_PERIOD" | "COMPLETED" | "CANCELLED" | "PENDING_PAYMENT";
      startAt: Date;
      endAt: Date;
      blockedUntil?: Date;
      checkedInAt?: Date;
      checkedOutAt?: Date;
      cancelledAt?: Date;
      cancellationReason?: string;
      holdExpiresAt?: Date;
      monthlyAgreementId?: string;
      hostPayoutId?: string | null;
      subtotalPaise?: number;
      paymentStatus?: "SUCCEEDED" | null;
      refundPaise?: number;
      events?: Array<{ type: "CHECK_IN" | "CHECK_OUT"; at: Date }>;
    },
  ) {
    const listing = listings[spec.listingIdx];
    const hours = Math.max(1, Math.round((spec.endAt.getTime() - spec.startAt.getTime()) / (60 * MIN)));
    const subtotal = spec.subtotalPaise ?? listing.hourlyPaise * Math.max(1, Math.round(hours / 60));
    const commission = Math.round((subtotal * POLICY_V1.commissionBps) / 10000);
    const hostEarnings = subtotal - commission;
    const blockedUntil = spec.blockedUntil ?? new Date(spec.endAt.getTime() + listing.turnover * MIN);
    const id = sid(`booking:${key}`);

    const bookingData: Prisma.BookingUncheckedCreateInput = {
      id,
      listingId: listing.id,
      renterId: riya.id,
      vehicleId: riyaVehicleId,
      rentalType: spec.rentalType,
      startAt: spec.startAt,
      endAt: spec.endAt,
      blockedUntil,
      status: spec.status,
      holdExpiresAt: spec.holdExpiresAt ?? null,
      monthlyAgreementId: spec.monthlyAgreementId ?? null,
      hostPayoutId: spec.hostPayoutId ?? null,
      subtotalPaise: subtotal,
      commissionPaise: commission,
      hostEarningsPaise: hostEarnings,
      totalPaise: subtotal,
      currency: "INR",
      checkedInAt: spec.checkedInAt ?? null,
      checkedOutAt: spec.checkedOutAt ?? null,
      cancelledAt: spec.cancelledAt ?? null,
      cancellationReason: spec.cancellationReason ?? null,
    };

    const booking = await db.booking.upsert({
      where: { id },
      create: bookingData,
      update: bookingData,
    });

    if (spec.events) {
      await db.sessionEvent.deleteMany({ where: { bookingId: id } });
      for (const ev of spec.events) {
        await db.sessionEvent.create({
          data: {
            bookingId: id,
            type: ev.type,
            actorId: riya.id,
            occurredAt: ev.at,
          },
        });
      }
    }

    if (spec.paymentStatus) {
      const paymentId = sid(`payment:${key}`);
      const orderId = `order_demo_${sid(`order:${key}`).slice(0, 16)}`;
      const paymentRef = `pay_demo_${sid(`pay:${key}`).slice(0, 16)}`;

      const payment = await db.payment.upsert({
        where: { id: paymentId },
        create: {
          id: paymentId,
          bookingId: id,
          provider: "razorpay",
          providerOrderId: orderId,
          providerPaymentId: paymentRef,
          amountPaise: subtotal,
          currency: "INR",
          status: spec.paymentStatus,
          signatureVerifiedAt: now,
        },
        update: {
          amountPaise: subtotal,
          status: spec.paymentStatus,
        },
      });

      await db.ledgerEntry.deleteMany({ where: { bookingId: id } });
      await db.ledgerEntry.createMany({
        data: [
          {
            bookingId: id,
            account: "RENTER_PAYMENT",
            amountPaise: subtotal,
            currency: "INR",
            reference: paymentRef,
            memo: "gross",
          },
          {
            bookingId: id,
            account: "PLATFORM_COMMISSION",
            amountPaise: commission,
            currency: "INR",
            reference: paymentRef,
            memo: "commission",
          },
          {
            bookingId: id,
            account: "HOST_EARNINGS",
            amountPaise: hostEarnings,
            currency: "INR",
            reference: paymentRef,
            memo: "host_payable",
          },
        ],
      });

      if (spec.refundPaise) {
        const refundId = sid(`refund:${key}`);
        const refundRef = `rfnd_demo_${sid(`rfnd:${key}`).slice(0, 16)}`;
        await db.refund.upsert({
          where: { id: refundId },
          create: {
            id: refundId,
            paymentId: payment.id,
            amountPaise: spec.refundPaise,
            currency: "INR",
            reason: "cancellation_refund",
            providerRefundId: refundRef,
            status: "SUCCEEDED",
            idempotencyKey: sid(`refund:idemp:${key}`),
            reconciledAt: now,
          },
          update: {
            amountPaise: spec.refundPaise,
            status: "SUCCEEDED",
          },
        });

        await db.ledgerEntry.create({
          data: {
            bookingId: id,
            account: "REFUND",
            amountPaise: spec.refundPaise,
            currency: "INR",
            reference: refundRef,
            memo: "cancellation_refund",
          },
        });
      }
    }

    return booking;
  }

  // 5.1 Upcoming CONFIRMED booking with access details
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 4, 30));
  const bConfirmed = await seedBooking("riya:confirmed", {
    listingIdx: 0,
    rentalType: "HOURLY",
    status: "CONFIRMED",
    startAt: tomorrow,
    endAt: new Date(tomorrow.getTime() + 2 * 60 * MIN),
    paymentStatus: "SUCCEEDED",
  });

  // 5.2 ACTIVE now with check-in
  await seedBooking("riya:active", {
    listingIdx: 1,
    rentalType: "HOURLY",
    status: "ACTIVE",
    startAt: new Date(now.getTime() - 45 * MIN),
    endAt: new Date(now.getTime() + 75 * MIN),
    checkedInAt: new Date(now.getTime() - 40 * MIN),
    paymentStatus: "SUCCEEDED",
    events: [{ type: "CHECK_IN", at: new Date(now.getTime() - 40 * MIN) }],
  });

  // 5.3 GRACE_PERIOD (overstaying 5 mins past endAt)
  await seedBooking("riya:grace", {
    listingIdx: 2,
    rentalType: "HOURLY",
    status: "GRACE_PERIOD",
    startAt: new Date(now.getTime() - 125 * MIN),
    endAt: new Date(now.getTime() - 5 * MIN),
    blockedUntil: new Date(now.getTime() + 10 * MIN),
    checkedInAt: new Date(now.getTime() - 120 * MIN),
    paymentStatus: "SUCCEEDED",
    events: [{ type: "CHECK_IN", at: new Date(now.getTime() - 120 * MIN) }],
  });

  // 5.4 COMPLETED with review pending
  await seedBooking("riya:completed", {
    listingIdx: 3,
    rentalType: "HOURLY",
    status: "COMPLETED",
    startAt: new Date(now.getTime() - 26 * 60 * MIN),
    endAt: new Date(now.getTime() - 24 * 60 * MIN),
    blockedUntil: new Date(now.getTime() - 24 * 60 * MIN),
    checkedInAt: new Date(now.getTime() - 26 * 60 * MIN),
    checkedOutAt: new Date(now.getTime() - 24 * 60 * MIN - 5 * MIN),
    paymentStatus: "SUCCEEDED",
    events: [
      { type: "CHECK_IN", at: new Date(now.getTime() - 26 * 60 * MIN) },
      { type: "CHECK_OUT", at: new Date(now.getTime() - 24 * 60 * MIN - 5 * MIN) },
    ],
  });

  // 5.5 CANCELLED with full refund
  const subtotalCancel = listings[4].hourlyPaise * 2;
  await seedBooking("riya:cancelled", {
    listingIdx: 4,
    rentalType: "HOURLY",
    status: "CANCELLED",
    startAt: new Date(now.getTime() + 48 * 60 * MIN),
    endAt: new Date(now.getTime() + 50 * 60 * MIN),
    cancelledAt: new Date(now.getTime() - 60 * MIN),
    cancellationReason: "Change of plans",
    subtotalPaise: subtotalCancel,
    paymentStatus: "SUCCEEDED",
    refundPaise: subtotalCancel,
  });

  // 5.6 PENDING_PAYMENT hold
  await seedBooking("riya:hold", {
    listingIdx: 5,
    rentalType: "HOURLY",
    status: "PENDING_PAYMENT",
    startAt: new Date(now.getTime() + 72 * 60 * MIN),
    endAt: new Date(now.getTime() + 74 * 60 * MIN),
    holdExpiresAt: new Date(now.getTime() + 9 * MIN),
  });

  // 5.7 ACTIVE monthly agreement near renewal (5 days left)
  const monthlyListing = listings[6];
  const monthlyAgreementId = sid("monthly:riya:harsh");
  const monthlyPaise = monthlyListing.hourlyPaise * 130;
  const monthlyStart = new Date(now.getTime() - 25 * 24 * 60 * MIN);
  const monthlyEnd = new Date(now.getTime() + 5 * 24 * 60 * MIN);

  const agreement = await db.monthlyAgreement.upsert({
    where: { id: monthlyAgreementId },
    create: {
      id: monthlyAgreementId,
      renterId: riya.id,
      listingId: monthlyListing.id,
      vehicleId: riyaVehicleId,
      monthlyPaise,
      currency: "INR",
      startAt: monthlyStart,
      currentTermStartAt: monthlyStart,
      currentTermEndAt: monthlyEnd,
      noticePeriodDays: 7,
      status: "ACTIVE",
      renewalReminderAt: new Date(now.getTime() - 2 * 24 * 60 * MIN),
      renewalDueAt: monthlyEnd,
    },
    update: {
      currentTermStartAt: monthlyStart,
      currentTermEndAt: monthlyEnd,
      status: "ACTIVE",
    },
  });

  await seedBooking("riya:monthly", {
    listingIdx: 6,
    rentalType: "MONTHLY",
    status: "CONFIRMED",
    startAt: monthlyStart,
    endAt: monthlyEnd,
    subtotalPaise: monthlyPaise,
    monthlyAgreementId: agreement.id,
    paymentStatus: "SUCCEEDED",
  });

  // 5.8 OPEN dispute on a completed booking
  const bDisputed = await seedBooking("riya:disputed", {
    listingIdx: 7,
    rentalType: "HOURLY",
    status: "COMPLETED",
    startAt: new Date(now.getTime() - 48 * 60 * MIN),
    endAt: new Date(now.getTime() - 46 * 60 * MIN),
    checkedInAt: new Date(now.getTime() - 48 * 60 * MIN),
    checkedOutAt: new Date(now.getTime() - 46 * 60 * MIN),
    paymentStatus: "SUCCEEDED",
  });

  const disputeId = sid("dispute:riya:1");
  await db.dispute.upsert({
    where: { id: disputeId },
    create: {
      id: disputeId,
      bookingId: bDisputed.id,
      raisedById: riya.id,
      category: "ACCESS_DENIED",
      description: "Security guard was away from Gate 2 for 45 minutes; had to wait outside.",
      evidenceUrls: [`${process.env.AUTH_URL || "http://localhost:3000"}/uploads/seed/parking-1.png`],
      status: "OPEN",
    },
    update: {
      category: "ACCESS_DENIED",
      description: "Security guard was away from Gate 2 for 45 minutes; had to wait outside.",
      status: "OPEN",
    },
  });

  // 5.9 OPEN report on listing 8
  const reportId = sid("report:riya:1");
  await db.report.upsert({
    where: { id: reportId },
    create: {
      id: reportId,
      reporterId: riya.id,
      targetType: "LISTING",
      targetId: listings[8].id,
      reason: "INACCURATE_LISTING",
      description: "Space description states private garage but it is an open driveway.",
      evidenceUrls: [`${process.env.AUTH_URL || "http://localhost:3000"}/uploads/seed/parking-2.png`],
      status: "OPEN",
    },
    update: {
      reason: "INACCURATE_LISTING",
      description: "Space description states private garage but it is an open driveway.",
      status: "OPEN",
    },
  });

  // 5.10 COMPLETED bookings eligible for host payout (>24h past endAt, unclaimed)
  await seedBooking("payout:1", {
    listingIdx: 9,
    rentalType: "DAILY",
    status: "COMPLETED",
    startAt: new Date(now.getTime() - 4 * 24 * 60 * MIN),
    endAt: new Date(now.getTime() - 3 * 24 * 60 * MIN),
    checkedInAt: new Date(now.getTime() - 4 * 24 * 60 * MIN),
    checkedOutAt: new Date(now.getTime() - 3 * 24 * 60 * MIN),
    subtotalPaise: 160000,
    paymentStatus: "SUCCEEDED",
  });

  await seedBooking("payout:2", {
    listingIdx: 10 % listings.length,
    rentalType: "HOURLY",
    status: "COMPLETED",
    startAt: new Date(now.getTime() - 5 * 24 * 60 * MIN),
    endAt: new Date(now.getTime() - 5 * 24 * 60 * MIN + 4 * 60 * MIN),
    checkedInAt: new Date(now.getTime() - 5 * 24 * 60 * MIN),
    checkedOutAt: new Date(now.getTime() - 5 * 24 * 60 * MIN + 4 * 60 * MIN),
    subtotalPaise: 120000,
    paymentStatus: "SUCCEEDED",
  });

  // 5.11 Notifications in the inbox
  const notifs = [
    {
      key: "riya:confirmed",
      userId: riya.id,
      type: "BOOKING_CONFIRMED_RENTER",
      payload: {
        bookingId: bConfirmed.id,
        listingTitle: listings[0].title,
        startAt: bConfirmed.startAt.toISOString(),
        endAt: bConfirmed.endAt.toISOString(),
      },
    },
    {
      key: "riya:arrival",
      userId: riya.id,
      type: "ARRIVAL_UPCOMING",
      payload: {
        bookingId: bConfirmed.id,
        listingTitle: listings[0].title,
        startAt: bConfirmed.startAt.toISOString(),
        endAt: bConfirmed.endAt.toISOString(),
      },
    },
    {
      key: "riya:renewal",
      userId: riya.id,
      type: "MONTHLY_RENEWAL_DUE",
      payload: {
        agreementId: agreement.id,
        listingTitle: monthlyListing.title,
        endAt: agreement.currentTermEndAt.toISOString(),
      },
    },
    {
      key: "harsh:booked",
      userId: harsh.id,
      type: "BOOKING_CONFIRMED_HOST",
      payload: {
        bookingId: bConfirmed.id,
        listingTitle: listings[0].title,
        startAt: bConfirmed.startAt.toISOString(),
        endAt: bConfirmed.endAt.toISOString(),
      },
    },
  ];

  for (const n of notifs) {
    const id = sid(`notif:${n.key}`);
    await db.notification.upsert({
      where: { idempotencyKey: id },
      create: {
        id,
        userId: n.userId,
        type: n.type,
        channel: "IN_APP",
        payload: n.payload,
        status: "SENT",
        scheduledAt: now,
        sentAt: now,
        readAt: null,
        idempotencyKey: id,
      },
      update: {
        payload: n.payload,
        status: "SENT",
      },
    });
  }

  const counts = await db.listing.groupBy({ by: ["status"], _count: true });
  const bookingCount = await db.booking.count();
  console.log(
    `Seeded policy v${policy.version}; listings:`,
    counts.map((c) => `${c.status}=${c._count}`).join(" "),
    `| Total bookings: ${bookingCount}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
