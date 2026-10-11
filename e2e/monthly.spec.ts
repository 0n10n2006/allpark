import { randomUUID } from "node:crypto";
import { type Cookie, expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers/session";

// Seeds straight into the dev server's database (DATABASE_URL); helpers/session loads .env.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const DAY = 24 * 60 * 60 * 1000;
const run = randomUUID().slice(0, 8);
const userIds: string[] = [];
const listingIds: string[] = [];
const agreementIds: string[] = [];
const bookingIds: string[] = [];

async function insert(sql: string, values: unknown[]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(sql, values);
  return rows[0].id;
}

let renterCookies: Cookie[];
let renterId: string;
let monthlyBookingId: string;
let agreementId: string;

test.beforeAll(async ({ browser }) => {
  await db.connect();
  const ctx = await browser.newContext();
  const renter = await signIn(ctx, test.info().project.use.baseURL!);
  renterId = renter.userId;
  renterCookies = await ctx.cookies();
  await ctx.close();
  userIds.push(renterId);

  // Host user
  const hostId = await insert(
    `INSERT INTO "User" (email, roles, name, "updatedAt")
     VALUES ($1, '{HOST}', 'Monthly Host', now()) RETURNING id`,
    [`${randomUUID()}@e2e.local`],
  );
  userIds.push(hostId);

  // Listing with MONTHLY offered (monthlyPaise set) and open 24x7
  const listingId = await insert(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise", "monthlyPaise",
       "accessInstructions", status, "updatedAt")
     VALUES ($1, $2, 'Covered space for monthly rental', $3, 'Kothrud', 18.50, 73.80, 18.501, 73.80, 'STILT',
       '{SEDAN}', 5000, 500000, 'Gate code 9999', 'PUBLISHED', now()) RETURNING id`,
    [hostId, `Monthly Bay ${run}`, `45 Paud Road ${run}`],
  );
  listingIds.push(listingId);

  // Availability rules 24x7 for all 7 days
  for (let weekday = 0; weekday < 7; weekday++) {
    await db.query(
      `INSERT INTO "AvailabilityRule" ("listingId", weekday, "startMinute", "endMinute", "updatedAt")
       VALUES ($1, $2, 0, 1440, now())`,
      [listingId, weekday],
    );
  }

  // Vehicle for renter
  const vehicleId = await insert(
    `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
     VALUES ($1, $2, 'SEDAN', 'My Sedan', now()) RETURNING id`,
    [renterId, `MH12MO${run.slice(0, 4).toUpperCase()}`],
  );

  // Active monthly agreement where current term ends in 5 days (in the future)
  const now = Date.now();
  const currentTermEnd = new Date(now + 5 * DAY);
  const currentTermStart = new Date(currentTermEnd.getTime() - 30 * DAY);

  agreementId = await insert(
    `INSERT INTO "MonthlyAgreement" ("renterId", "listingId", "vehicleId", "monthlyPaise",
       currency, "startAt", "currentTermStartAt", "currentTermEndAt", "noticePeriodDays",
       status, "renewalDueAt", "renewalReminderAt", "updatedAt")
     VALUES ($1, $2, $3, 500000, 'INR', $4, $4, $5, 7, 'ACTIVE', $5, $6, now()) RETURNING id`,
    [
      renterId,
      listingId,
      vehicleId,
      currentTermStart,
      currentTermEnd,
      new Date(currentTermEnd.getTime() - 7 * DAY),
    ],
  );
  agreementIds.push(agreementId);

  // Initial term booking CONFIRMED
  monthlyBookingId = await insert(
    `INSERT INTO "Booking" ("listingId", "renterId", "vehicleId", "rentalType", "startAt", "endAt",
       "blockedUntil", status, "subtotalPaise", "commissionPaise", "hostEarningsPaise",
       "totalPaise", "monthlyAgreementId", "updatedAt")
     VALUES ($1, $2, $3, 'MONTHLY', $4, $5, $5, 'CONFIRMED', 500000, 50000, 450000, 500000, $6, now()) RETURNING id`,
    [listingId, renterId, vehicleId, currentTermStart, currentTermEnd, agreementId],
  );
  bookingIds.push(monthlyBookingId);
});

test.afterAll(async () => {
  // Cleanup bookings for the listings
  await db.query(`DELETE FROM "Booking" WHERE "listingId" = ANY($1::uuid[])`, [listingIds]);
  await db.query(`DELETE FROM "MonthlyAgreement" WHERE id = ANY($1::uuid[])`, [agreementIds]);
  await db.query(`DELETE FROM "PriceQuote" WHERE "listingId" = ANY($1::uuid[])`, [listingIds]);
  await db.query(`DELETE FROM "AvailabilityRule" WHERE "listingId" = ANY($1::uuid[])`, [listingIds]);
  await db.query(`DELETE FROM "Listing" WHERE id = ANY($1::uuid[])`, [listingIds]);
  await db.query(`DELETE FROM "Vehicle" WHERE "userId" = ANY($1::uuid[])`, [userIds]);
  await db.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [userIds]);
  await db.end();
});

test("a renter with a seeded active monthly agreement clicks Renew on /bookings/[id] and lands on /checkout/[bookingId] for the next term", async ({
  page,
  context,
}) => {
  await context.addCookies(renterCookies);
  await page.goto(`/bookings/${monthlyBookingId}`);

  // Heading and Monthly section
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Monthly Bay ${run}`);
  await expect(page.getByRole("heading", { level: 2, name: "Monthly rental" })).toBeVisible();
  await expect(page.getByText("Active")).toBeVisible();
  await expect(
    page.getByText("Renewal is manual. You won't be charged automatically."),
  ).toBeVisible();

  // Click Renew button
  const renewBtn = page.getByRole("button", { name: "Renew for next month" });
  await expect(renewBtn).toBeVisible();
  await renewBtn.click();

  // Should navigate to checkout for the newly created next-term hold
  await page.waitForURL(/\/checkout\/[a-f0-9-]+/);
  await expect(page.getByRole("heading", { level: 1, name: "Checkout" })).toBeVisible();
  await expect(page.getByRole("link", { name: `Monthly Bay ${run}` })).toBeVisible();
});
