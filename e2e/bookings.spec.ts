import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { type Cookie, type Page, expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers/session";

// Seeds straight into the dev server's database (DATABASE_URL); helpers/session loads .env.
// Plain SQL: Playwright's loader can't import the ESM-only generated Prisma client.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const MIN = 60_000;
const run = randomUUID().slice(0, 8); // mobile and desktop projects seed side by side
const userIds: string[] = [];
const listingIds: string[] = [];

async function insert(sql: string, values: unknown[]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(sql, values);
  return rows[0].id;
}

/** Each booking gets its own listing, so the overlap constraint never interferes. */
async function seedBooking(
  renterId: string,
  title: string,
  status: string,
  startAt: Date,
  endAt: Date,
) {
  const hostId = await insert(
    `INSERT INTO "User" (email, roles, name, "updatedAt")
     VALUES ($1, '{HOST}', 'Asha Host', now()) RETURNING id`,
    [`${randomUUID()}@e2e.local`],
  );
  userIds.push(hostId);
  const listingId = await insert(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
       "accessInstructions", status, "updatedAt")
     VALUES ($1, $2, 'Covered', $3, 'Shivajinagar', 18.53, 73.84, 18.531, 73.84, 'STILT',
       '{SEDAN}', 5000, 'Gate code 4321', 'PUBLISHED', now()) RETURNING id`,
    [hostId, `${title} ${run}`, `12 FC Road ${run}`],
  );
  listingIds.push(listingId);
  const id = await insert(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
       "blockedUntil", status, "holdExpiresAt", "subtotalPaise", "commissionPaise",
       "hostEarningsPaise", "totalPaise", "updatedAt")
     VALUES ($1, $2, 'HOURLY', $3, $4, $4, $5, $6, 10000, 1000, 9000, 10000, now()) RETURNING id`,
    [
      listingId,
      renterId,
      startAt,
      endAt,
      status,
      status === "PENDING_PAYMENT" ? new Date(Date.now() + 10 * MIN) : null,
    ],
  );
  return { id };
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

let renterCookies: Cookie[];
let confirmed: { id: string };
let pending: { id: string };
let cancellable: { id: string };

test.beforeAll(async ({ browser }) => {
  await db.connect();
  const ctx = await browser.newContext();
  const renter = { id: (await signIn(ctx, test.info().project.use.baseURL!)).userId };
  renterCookies = await ctx.cookies();
  await ctx.close();
  userIds.push(renter.id);
  const now = Date.now();
  // Starts a minute ago so the countdown is already on "Time remaining".
  confirmed = await seedBooking(
    renter.id,
    "Confirmed bay",
    "CONFIRMED",
    new Date(now - MIN),
    new Date(now + 120 * MIN),
  );
  await seedBooking(
    renter.id,
    "Finished bay",
    "COMPLETED",
    new Date(now - 48 * 60 * MIN),
    new Date(now - 46 * 60 * MIN),
  );
  pending = await seedBooking(
    renter.id,
    "Pending bay",
    "PENDING_PAYMENT",
    new Date(now + 24 * 60 * MIN),
    new Date(now + 26 * 60 * MIN),
  );
  // Starts tomorrow, so the cancel dialog is offered; no payment, so no refund row.
  cancellable = await seedBooking(
    renter.id,
    "Cancellable bay",
    "CONFIRMED",
    new Date(now + 24 * 60 * MIN),
    new Date(now + 26 * 60 * MIN),
  );
});

test.afterAll(async () => {
  await db.query(
    `DELETE FROM "Dispute" WHERE "bookingId" IN (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]))`,
    [listingIds],
  );
  await db.query(`DELETE FROM "Booking" WHERE "listingId" = ANY($1::uuid[])`, [listingIds]);
  await db.query(`DELETE FROM "Listing" WHERE id = ANY($1::uuid[])`, [listingIds]);
  // Sessions cascade with their user.
  await db.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [userIds]);
  await db.end();
});

test("tabs sort bookings into upcoming, active and past", async ({ page, context }) => {
  await context.addCookies(renterCookies);
  await page.goto("/bookings");

  const panel = page.getByRole("tabpanel");
  await expect(page.getByRole("tab", { name: /Upcoming/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByText(`Confirmed bay ${run}`)).toBeVisible();
  await expect(panel.getByText(`Pending bay ${run}`)).toBeVisible();
  await expect(panel.getByText("Awaiting payment")).toBeVisible();
  await expect(panel.getByText(`Finished bay ${run}`)).toHaveCount(0);
  await expectAccessibleAt375(page);

  expect(
    (await page.getByRole("tab", { name: /Past/ }).boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  await page.getByRole("tab", { name: /Past/ }).click();
  await expect(panel.getByText(`Finished bay ${run}`)).toBeVisible();
  await expect(panel.getByText("Completed")).toBeVisible();
  await expectAccessibleAt375(page);

  // A finished booking no longer exposes the address or gate code.
  await panel.getByText(`Finished bay ${run}`).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Finished bay ${run}`);
  await expect(page.getByTestId("access-pending")).toBeVisible();
  await expect(page.getByText("Gate code 4321")).toHaveCount(0);
  await expect(page.getByTestId("countdown")).toHaveCount(0);
  await page.goBack();

  await expect(page.getByRole("tab", { name: /Upcoming/ })).toBeVisible();
  await page.getByRole("tab", { name: /Active/ }).click();
  await expect(panel.getByRole("link", { name: "Find parking" })).toHaveAttribute(
    "href",
    "/explore",
  );
  await expectAccessibleAt375(page);
});

test("confirmed booking shows a countdown, access details and Start parking", async ({
  page,
  context,
}) => {
  await context.addCookies(renterCookies);
  await page.goto(`/bookings/${confirmed.id}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Confirmed bay ${run}`);
  await expect(page.getByTestId("countdown")).toHaveText(/^1h 5\dm \d+s$/);
  await expect(page.getByText(/Time remaining \d hour/)).toHaveAttribute("aria-live", "polite");
  await expect(page.getByText(`12 FC Road ${run}`)).toBeVisible();
  await expect(page.getByText("Gate code 4321")).toBeVisible();
  const start = page.getByRole("button", { name: "Start parking" });
  await expect(start).toBeVisible();
  expect((await start.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectAccessibleAt375(page);

  // Check-in is a Phase 4 stub (501): the UI says so instead of failing.
  await start.click();
  await expect(page.getByText("Coming soon")).toBeVisible();
});

test("pending booking hides access details and has no countdown", async ({ page, context }) => {
  await context.addCookies(renterCookies);
  await page.goto(`/bookings/${pending.id}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Pending bay ${run}`);
  await expect(page.getByTestId("access-pending")).toBeVisible();
  await expect(page.getByText(`12 FC Road ${run}`)).toHaveCount(0);
  await expect(page.getByTestId("countdown")).toHaveCount(0);
  await expectAccessibleAt375(page);

  await page.getByRole("button", { name: "Cancel booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this booking?" });
  await expect(
    dialog.getByText(/Full refund if cancelled at least 2 hours before start/),
  ).toBeVisible();
  await expectAccessibleAt375(page);
});

test("renter cancels a confirmed booking from the dialog", async ({ page, context }) => {
  await context.addCookies(renterCookies);
  await page.goto(`/bookings/${cancellable.id}`);

  await page.getByRole("button", { name: "Cancel booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this booking?" });
  await dialog.getByRole("button", { name: "Cancel booking" }).click();
  // First cancel compiles the route in dev mode; allow for it.
  await expect(page.getByText("Booking cancelled.")).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Cancelled").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel booking" })).toHaveCount(0);
});

test("renter reports a problem on a confirmed booking", async ({ page, context }) => {
  await context.addCookies(renterCookies);
  await page.goto(`/bookings/${confirmed.id}`);

  await page.getByRole("button", { name: "Report a problem" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a problem" });
  await dialog.getByLabel("Details").fill("The gate was locked when I arrived.");
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Report sent. We'll be in touch.")).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toHaveCount(0);
});

test("another user gets the not-found state for my booking", async ({ page, context, baseURL }) => {
  userIds.push((await signIn(context, baseURL!)).userId);
  await page.goto(`/bookings/${confirmed.id}`);

  await expect(page.getByRole("heading", { name: "We couldn't find that booking" })).toBeVisible();
  await expect(page.getByText(`12 FC Road ${run}`)).toHaveCount(0);
  await expect(page.getByText("Gate code 4321")).toHaveCount(0);
});
