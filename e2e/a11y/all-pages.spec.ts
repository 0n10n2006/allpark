import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "../helpers/session";

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {}
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

type RouteConfig = {
  file: string;
  url: (data: SeedData) => string;
  role: "PUBLIC" | "RENTER" | "HOST" | "ADMIN";
};

type SeedData = {
  publishedListingId: string;
  hostListingId: string;
  confirmedBookingId: string;
  holdBookingId: string;
  renterId: string;
  hostId: string;
  adminId: string;
};

let seedData: SeedData;

function findPageFiles(dir = "src/app", base = ""): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "page.tsx") {
      results.push(base ? `${base}/page.tsx` : "page.tsx");
    } else if (entry.isDirectory()) {
      results.push(...findPageFiles(join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name));
    }
  }
  return results;
}

const ROUTE_CONFIGS: RouteConfig[] = [
  { file: "page.tsx", url: () => "/", role: "PUBLIC" },
  { file: "explore/page.tsx", url: () => "/explore", role: "PUBLIC" },
  { file: "(auth)/sign-in/page.tsx", url: () => "/sign-in", role: "PUBLIC" },
  { file: "(auth)/sign-out/page.tsx", url: () => "/sign-out", role: "PUBLIC" },
  { file: "listings/[id]/page.tsx", url: (d) => `/listings/${d.publishedListingId}`, role: "PUBLIC" },
  { file: "account/page.tsx", url: () => "/account", role: "RENTER" },
  { file: "bookings/page.tsx", url: () => "/bookings", role: "RENTER" },
  { file: "bookings/[id]/page.tsx", url: (d) => `/bookings/${d.confirmedBookingId}`, role: "RENTER" },
  { file: "checkout/[bookingId]/page.tsx", url: (d) => `/checkout/${d.holdBookingId}`, role: "RENTER" },
  { file: "host/page.tsx", url: () => "/host", role: "HOST" },
  { file: "host/bookings/page.tsx", url: () => "/host/bookings", role: "HOST" },
  { file: "host/earnings/page.tsx", url: () => "/host/earnings", role: "HOST" },
  { file: "host/listings/new/page.tsx", url: () => "/host/listings/new", role: "HOST" },
  { file: "host/listings/[id]/edit/page.tsx", url: (d) => `/host/listings/${d.hostListingId}/edit`, role: "HOST" },
  { file: "admin/page.tsx", url: () => "/admin", role: "ADMIN" },
  { file: "admin/bookings/page.tsx", url: () => "/admin/bookings", role: "ADMIN" },
  { file: "admin/disputes/page.tsx", url: () => "/admin/disputes", role: "ADMIN" },
  { file: "admin/jobs/page.tsx", url: () => "/admin/jobs", role: "ADMIN" },
  { file: "admin/listings/page.tsx", url: () => "/admin/listings", role: "ADMIN" },
  { file: "admin/payments/page.tsx", url: () => "/admin/payments", role: "ADMIN" },
  { file: "admin/payouts/page.tsx", url: () => "/admin/payouts", role: "ADMIN" },
  { file: "admin/photos/page.tsx", url: () => "/admin/photos", role: "ADMIN" },
  { file: "admin/reports/page.tsx", url: () => "/admin/reports", role: "ADMIN" },
  { file: "admin/reviews/page.tsx", url: () => "/admin/reviews", role: "ADMIN" },
  { file: "admin/users/page.tsx", url: () => "/admin/users", role: "ADMIN" },
];

test.beforeAll(async () => {
  await db.connect();
  const run = randomUUID().slice(0, 8);

  // 1. Host + listing
  const hostRes = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, name, roles, "hostVerificationStatus", "updatedAt")
     VALUES ($1, 'A11y Host', '{HOST}', 'VERIFIED', now()) RETURNING id`,
    [`a11y-host-${run}@test.local`],
  );
  const hostId = hostRes.rows[0].id;

  const hostListingRes = await db.query<{ id: string }>(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
       "accessInstructions", status, "hostAttestedAt", "updatedAt")
     VALUES ($1, $2, 'A11y test covered parking', '100 FC Road', 'Shivajinagar', 18.52, 73.85,
       18.521, 73.851, 'COVERED', '{SEDAN,SUV}', 5000, 'Gate PIN 9999', 'PUBLISHED', now(), now()) RETURNING id`,
    [hostId, `A11y Host Space ${run}`],
  );
  const hostListingId = hostListingRes.rows[0].id;

  // Published listing for public view
  const pubListingRes = await db.query<{ id: string }>(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
       "accessInstructions", status, "hostAttestedAt", "updatedAt")
     VALUES ($1, $2, 'A11y public space', '101 MG Road', 'Camp', 18.51, 73.87,
       18.511, 73.871, 'STILT', '{SEDAN}', 4000, 'Gate code 1111', 'PUBLISHED', now(), now()) RETURNING id`,
    [hostId, `A11y Public Space ${run}`],
  );
  const publishedListingId = pubListingRes.rows[0].id;

  // Add availability rules and photos for both
  for (const lid of [hostListingId, publishedListingId]) {
    for (let d = 0; d < 7; d++) {
      await db.query(
        `INSERT INTO "AvailabilityRule" ("listingId", weekday, "startMinute", "endMinute", "updatedAt")
         VALUES ($1, $2, 0, 1440, now())`,
        [lid, d],
      );
    }
    await db.query(
      `INSERT INTO "ListingPhoto" ("listingId", url, position, "moderationStatus", "updatedAt")
       VALUES ($1, 'https://res.cloudinary.com/demo/image/upload/sample.jpg', 0, 'APPROVED', now())`,
      [lid],
    );
  }

  // 2. Renter + vehicle
  const renterRes = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, name, roles, "updatedAt")
     VALUES ($1, 'A11y Renter', '{RENTER}', now()) RETURNING id`,
    [`a11y-renter-${run}@test.local`],
  );
  const renterId = renterRes.rows[0].id;

  await db.query(
    `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
     VALUES ($1, $2, 'SEDAN', 'City Sedan', now())`,
    [renterId, `MH12AB${run.slice(0, 4).toUpperCase()}`],
  );

  // Confirmed booking for /bookings/[id]
  const confirmedRes = await db.query<{ id: string }>(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
       "blockedUntil", status, "subtotalPaise", "commissionPaise", "hostEarningsPaise",
       "totalPaise", "updatedAt")
     VALUES ($1, $2, 'HOURLY', now() + interval '2 hours', now() + interval '4 hours',
       now() + interval '4 hours', 'CONFIRMED', 10000, 1000, 9000, 10000, now()) RETURNING id`,
    [hostListingId, renterId],
  );
  const confirmedBookingId = confirmedRes.rows[0].id;

  // Hold booking for /checkout/[bookingId]
  const holdRes = await db.query<{ id: string }>(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
       "blockedUntil", status, "holdExpiresAt", "subtotalPaise", "commissionPaise",
       "hostEarningsPaise", "totalPaise", "updatedAt")
     VALUES ($1, $2, 'HOURLY', now() + interval '5 hours', now() + interval '7 hours',
       now() + interval '7 hours', 'PENDING_PAYMENT', now() + interval '15 minutes', 10000, 1000, 9000, 10000, now()) RETURNING id`,
    [publishedListingId, renterId],
  );
  const holdBookingId = holdRes.rows[0].id;

  // 3. Admin user
  const adminRes = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, name, roles, "updatedAt")
     VALUES ($1, 'A11y Admin', '{ADMIN}', now()) RETURNING id`,
    [`a11y-admin-${run}@test.local`],
  );
  const adminId = adminRes.rows[0].id;

  seedData = {
    publishedListingId,
    hostListingId,
    confirmedBookingId,
    holdBookingId,
    renterId,
    hostId,
    adminId,
  };
});

test.afterAll(async () => {
  await db.end();
});

test.describe("Accessibility: All pages sweep", () => {
  test("every page.tsx is mapped in test configuration", () => {
    const discovered = findPageFiles().map((p) => p.replace(/\\/g, "/"));
    const configured = ROUTE_CONFIGS.map((c) => c.file);
    const missing = discovered.filter((f) => !configured.includes(f));
    expect(missing).toEqual([]);
    expect(discovered.length).toBe(ROUTE_CONFIGS.length);
  });

  test("skip link works on public shell", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/explore");
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    expect(page.url()).toContain("#main");
    await expect(page.locator("#main")).toBeVisible();
  });

  for (const config of ROUTE_CONFIGS) {
    for (const width of [375, 1280] as const) {
      test(`${config.file} (${config.role}) at ${width}px: 1 h1, no horizontal overflow, 0 serious/critical axe violations`, async ({
        page,
        context,
      }) => {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });

        if (config.role === "RENTER") {
          const user = await signIn(context, { roles: ["RENTER"] });
          // Ensure renter owns the bookings and has a vehicle
          await db.query(
            `UPDATE "Booking" SET "renterId" = $1 WHERE id IN ($2, $3)`,
            [user.userId, seedData.confirmedBookingId, seedData.holdBookingId],
          );
          await db.query(
            `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
             VALUES ($1, $2, 'SEDAN', 'City Sedan', now())`,
            [user.userId, `MH12AP${randomUUID().slice(0, 4).toUpperCase()}`],
          );
        } else if (config.role === "HOST") {
          const user = await signIn(context, { roles: ["HOST"], hostVerificationStatus: "VERIFIED" });
          await db.query(
            `UPDATE "Listing" SET "hostId" = $1 WHERE id = $2`,
            [user.userId, seedData.hostListingId],
          );
        } else if (config.role === "ADMIN") {
          await signIn(context, { roles: ["ADMIN"] });
        }

        const targetUrl = config.url(seedData);
        await page.goto(targetUrl);

        // Wait for hydration/content
        await page.waitForLoadState("domcontentloaded");

        // 1. Exactly one h1 per page
        const h1s = page.getByRole("heading", { level: 1 });
        await expect(h1s).toHaveCount(1);

        // 2. No horizontal scroll at 375px
        if (width === 375) {
          const hasHorizontalOverflow = await page.evaluate(
            () => document.scrollingElement!.scrollWidth > window.innerWidth,
          );
          expect(hasHorizontalOverflow).toBe(false);
        }

        // 3. Axe with wcag2a / wcag2aa tags -> 0 serious/critical violations
        const axeResults = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .analyze();

        const badViolations = axeResults.violations.filter((v) =>
          ["serious", "critical"].includes(v.impact ?? ""),
        );

        if (badViolations.length > 0) {
          console.error(
            `Axe violations on ${targetUrl} (${width}px):`,
            JSON.stringify(badViolations, null, 2),
          );
        }

        expect(
          badViolations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`),
        ).toEqual([]);
      });
    }
  }
});
