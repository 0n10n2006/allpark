import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers/session";

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const MIN = 60_000;
const run = randomUUID().slice(0, 8);
const userIds: string[] = [];
const listingIds: string[] = [];

async function insert(sql: string, values: unknown[]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(sql, values);
  return rows[0].id;
}

async function expectAccessibleAt375(page: Page) {
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")),
  ).toEqual([]);
}

test.beforeAll(async () => {
  await db.connect();
});

test.afterAll(async () => {
  await db.query(
    `DELETE FROM "SessionEvent" WHERE "bookingId" IN
       (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]))`,
    [listingIds],
  );
  await db.query(`DELETE FROM "Booking" WHERE "listingId" = ANY($1::uuid[])`, [listingIds]);
  await db.query(`DELETE FROM "Listing" WHERE id = ANY($1::uuid[])`, [listingIds]);
  await db.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [userIds]);
  await db.end();
});

test("host sees booking on their listing and confirms arrival", async ({
  browser,
  baseURL,
}) => {
  const ctx = await browser.newContext();
  const host = await signIn(ctx, baseURL!);
  userIds.push(host.userId);

  // Give host the HOST role
  await db.query(
    `UPDATE "User" SET roles = '{HOST}', name = 'Pooja Host' WHERE id = $1`,
    [host.userId],
  );

  // Create renter
  const renterId = await insert(
    `INSERT INTO "User" (email, roles, name, "updatedAt")
     VALUES ($1, '{USER}', 'Rohan Renter', now()) RETURNING id`,
    [`${randomUUID()}@renter.local`],
  );
  userIds.push(renterId);

  // Host's published listing
  const listingId = await insert(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
       "accessInstructions", status, "updatedAt")
     VALUES ($1, $2, 'Open slot', $3, 'Koregaon Park', 18.53, 73.89, 18.531, 73.891, 'OPEN',
       '{SEDAN}', 6000, 'Ring bell 101', 'PUBLISHED', now()) RETURNING id`,
    [host.userId, `Host Spot ${run}`, `Lane 5 KP ${run}`],
  );
  listingIds.push(listingId);

  // Confirmed booking on host's listing
  const now = Date.now();
  const bookingId = await insert(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
       "blockedUntil", status, "holdExpiresAt", "subtotalPaise", "commissionPaise",
       "hostEarningsPaise", "totalPaise", "updatedAt")
     VALUES ($1, $2, 'HOURLY', $3, $4, $4, 'CONFIRMED', null, 12000, 1200, 10800, 12000, now()) RETURNING id`,
    [
      listingId,
      renterId,
      new Date(now - MIN),
      new Date(now + 120 * MIN),
    ],
  );

  const page = await ctx.newPage();

  // Navigate to /host
  await page.goto("/host");
  const bookingsLink = page.getByRole("link", { name: "Bookings" });
  await expect(bookingsLink).toBeVisible();
  await bookingsLink.click();

  await expect(page).toHaveURL(/\/host\/bookings/);
  await expect(page.getByRole("heading", { level: 1, name: "Host bookings" })).toBeVisible();

  // Expect booking card with Confirmed badge
  await expect(page.getByText(`Host Spot ${run}`)).toBeVisible();
  await expect(page.getByText("Confirmed")).toBeVisible();
  await expectAccessibleAt375(page);

  // Confirm arrival as host
  const confirmArrivalBtn = page.getByRole("button", { name: "Confirm arrival" });
  await expect(confirmArrivalBtn).toBeVisible();
  await confirmArrivalBtn.click();

  // Toast and status update to "Parked now" (ACTIVE)
  await expect(page.getByText("Arrival confirmed.")).toBeVisible();
  await expect(page.getByText("Parked now")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm departure" })).toBeVisible();

  await ctx.close();
});
