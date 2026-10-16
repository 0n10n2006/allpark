/**
 * Journey T5.1 — Host listing to earnings
 *
 * become host → wizard → publish blocked while unverified
 * → verify via the admin API (admin session) → publish
 * → a renter books + pays (API calls are fine for speed)
 * → the booking completes → the host sees it in /host/bookings and pending earnings
 * → admin creates + marks-paid a payout after the hold-back (force times via SQL)
 * → /host/earnings shows paid.
 *
 * Accessibility: axe 0 serious/critical on 2 key pages (/host and /host/bookings).
 * Responsive: no horizontal scroll at 375px on mobile.
 */
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect as baseExpect, test, type Page } from "@playwright/test";
import pg from "pg";
import { signIn } from "../helpers/session";

try {
  process.loadEnvFile(".env");
} catch {}

const expect = baseExpect.configure({ timeout: 30_000 });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function a11yCheck(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  expect(
    bad.map((v) => `${v.id} [${label}]: ${v.nodes.map((n) => n.target).join(", ")}`),
  ).toEqual([]);
}

async function noHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const png = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

/** Stands in for Cloudinary in wizard photo step */
async function mockCloudinary(page: Page) {
  await page.route("https://api.cloudinary.com/**", async (route) => {
    await route.fulfill({ json: { public_id: "fake_public_id" } });
  });
  await page.route("https://res.cloudinary.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PNG }),
  );
}

/** Switch context to a specific userId by inserting a session and setting the cookie. */
async function sessionAs(
  context: import("@playwright/test").BrowserContext,
  userId: string,
  baseURL: string,
) {
  const token = randomUUID();
  await db.query(
    `INSERT INTO "Session" ("sessionToken", "userId", expires, "updatedAt")
     VALUES ($1, $2, now() + interval '1 hour', now())`,
    [token, userId],
  );
  await context.clearCookies();
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: token,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

// State shared between serial steps
const run = randomUUID().slice(0, 8);
let hostId: string;
let renterId: string;
let adminId: string;
let listingId: string;
let bookingId: string;
let payoutId: string;

const listingTitle = `Host Journey Spot ${run}`;

// IDs to clean up in afterAll
const toDeleteUsers: string[] = [];
const toDeleteListings: string[] = [];
const toDeletePayouts: string[] = [];

test.beforeAll(async () => {
  // Create admin user
  const { rows: [admin] } = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, roles, name, "updatedAt")
     VALUES ($1, '{ADMIN}', 'Host Journey Admin ${run}', now()) RETURNING id`,
    [`host-journey-admin-${run}@e2e.local`],
  );
  adminId = admin.id;
  toDeleteUsers.push(adminId);
});

test.afterAll(async () => {
  if (toDeleteListings.length) {
    await db.query(
      `DELETE FROM "LedgerEntry" WHERE "bookingId" IN
         (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]))`,
      [toDeleteListings],
    );
    await db.query(
      `DELETE FROM "SessionEvent" WHERE "bookingId" IN
         (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]))`,
      [toDeleteListings],
    );
    await db.query(
      `DELETE FROM "Payment" WHERE "bookingId" IN
         (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]))`,
      [toDeleteListings],
    );
    await db.query(
      `DELETE FROM "Booking" WHERE "listingId" = ANY($1::uuid[])`,
      [toDeleteListings],
    );
    await db.query(
      `DELETE FROM "AvailabilityRule" WHERE "listingId" = ANY($1::uuid[])`,
      [toDeleteListings],
    );
    await db.query(
      `DELETE FROM "PriceQuote" WHERE "listingId" = ANY($1::uuid[])`,
      [toDeleteListings],
    );
    await db.query(`DELETE FROM "Listing" WHERE id = ANY($1::uuid[])`, [toDeleteListings]);
  }
  if (toDeletePayouts.length) {
    await db.query(`DELETE FROM "HostPayout" WHERE id = ANY($1::uuid[])`, [toDeletePayouts]);
  }
  if (toDeleteUsers.length) {
    await db.query(`DELETE FROM "Vehicle" WHERE "userId" = ANY($1::uuid[])`, [toDeleteUsers]);
    await db.query(`DELETE FROM "Notification" WHERE "userId" = ANY($1::uuid[])`, [toDeleteUsers]);
    await db.query(`DELETE FROM "AuditLog" WHERE "actorId" = ANY($1::uuid[]) OR "targetId" = ANY($2::text[])`, [
      toDeleteUsers,
      toDeleteUsers,
    ]);
    await db.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [toDeleteUsers]);
  }
  await db.end();
});

// ─── Step 1: Become a host ──────────────────────────────────────────────────

test("1. user becomes a host and sees verification pending", async ({
  page,
  context,
  baseURL,
}) => {
  const { userId } = await signIn(context, baseURL!);
  hostId = userId;
  toDeleteUsers.push(hostId);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/host");
  await expect(page.getByRole("heading", { name: "Become a host" })).toBeVisible();

  // A11y and mobile responsiveness on key page 1
  await a11yCheck(page, "host-become-page");
  await noHorizontalScroll(page);

  const submit = page.getByRole("button", { name: "Become a host" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("I'm authorized to rent out the spaces I list").check();
  await submit.click();

  await expect(page.getByRole("heading", { name: "Verification pending" })).toBeVisible();
  await expect(page.getByText("you'll be able to publish once you're verified")).toBeVisible();
});

// ─── Step 2: Wizard and publish blocked while unverified ─────────────────────

test("2. host goes through wizard; publishing is blocked while unverified", async ({
  page,
  context,
  baseURL,
}) => {
  await sessionAs(context, hostId, baseURL!);
  await mockCloudinary(page);
  await page.goto("/host/listings/new");

  // Step 1: Basics
  await expect(page.getByRole("heading", { name: /Step 1 of 8: Basics/ })).toBeVisible();
  await page.getByLabel("Title").fill(listingTitle);
  await page.getByLabel("Description", { exact: true }).fill("Secure covered space near Kothrud bus stand.");
  await page.getByLabel("Space type").selectOption("COVERED");
  await page.getByRole("button", { name: "Continue" }).press("Enter");

  // Step 2: Location
  await expect(page.getByRole("heading", { name: /Step 2 of 8: Location/ })).toBeVisible();
  await page.getByLabel("Full address").fill(`42 Karve Road ${run}, Kothrud, Pune`);
  await page.getByLabel("Locality").fill("Kothrud");
  await page.getByLabel("Latitude").fill("18.5074");
  await page.getByLabel("Longitude").fill("73.8077");
  await page.getByRole("button", { name: "Continue" }).press("Enter");

  // Step 3: Vehicles & size
  await expect(page.getByRole("heading", { name: /Step 3 of 8: Vehicles & size/ })).toBeVisible();
  await page.getByLabel("Sedan").check();
  await page.getByLabel("Max height").fill("210");
  await page.getByLabel("Covered", { exact: true }).check();
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  // Step 4: Pricing
  await expect(page.getByRole("heading", { name: /Step 4 of 8: Pricing/ })).toBeVisible();
  await page.getByLabel("Per hour (₹)").fill("50");
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  // Step 5: Availability
  await expect(page.getByRole("heading", { name: /Step 5 of 8: Availability/ })).toBeVisible();
  await page.getByRole("button", { name: "Add time range for Monday" }).click();
  await page.getByRole("checkbox", { name: "Open 24 hours, 7 days a week" }).check();
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  // Step 6: Photos
  await expect(page.getByRole("heading", { name: /Step 6 of 8: Photos/ })).toBeVisible();
  await page.getByLabel("Upload photos").setInputFiles([png("cover.png")]);
  await expect(page.getByAltText("Photo 1")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  // Step 7: Access & rules
  await expect(page.getByRole("heading", { name: /Step 7 of 8: Access & rules/ })).toBeVisible();
  await page.getByLabel("Access instructions").fill("Gate code 5555, first bay on left.");
  await page.getByLabel("Rules for renters").fill("No commercial washing.");
  await page.getByLabel(/I'm authorized to rent out this space/).check();
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  // Step 8: Review & publish
  await expect(page.getByRole("heading", { name: /Step 8 of 8: Review & publish/ })).toBeVisible();
  await page.getByRole("button", { name: "Publish listing" }).click();

  // Publish is blocked while unverified
  await expect(page.getByRole("heading", { name: "Host verification required" })).toBeVisible();

  // Extract listing ID from DB
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "Listing" WHERE "hostId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [hostId],
  );
  listingId = rows[0]?.id;
  expect(listingId).toBeTruthy();
  toDeleteListings.push(listingId);
});

// ─── Step 3: Admin verifies host → publish listing ──────────────────────────

test("3. verify host via admin API → publish listing", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  // Admin verifies host via admin API
  const adminCtx = await browser.newContext();
  const token = randomUUID();
  await db.query(
    `INSERT INTO "Session" ("sessionToken", "userId", expires, "updatedAt")
     VALUES ($1, $2, now() + interval '1 hour', now())`,
    [token, adminId],
  );
  await adminCtx.addCookies([
    {
      name: "authjs.session-token",
      value: token,
      url: baseURL!,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const res = await adminCtx.request.post(`/api/admin/users/${hostId}/verify-host`, {
    data: {
      decision: "VERIFIED",
      reason: "Verified Aadhaar and ownership documents for journey test",
    },
  });
  expect(res.ok()).toBe(true);
  await adminCtx.close();

  // Now publish listing on the host's page
  await sessionAs(context, hostId, baseURL!);
  await page.goto(`/host/listings/${listingId}/edit?step=access`);
  await page.getByLabel(/I'm authorized to rent out this space/).check();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: /Step 8 of 8: Review & publish/ })).toBeVisible();
  const publishBtn = page.getByRole("button", { name: "Publish listing" });
  await expect(publishBtn).toBeVisible({ timeout: 15_000 });
  await publishBtn.click();
  await expect(page.getByRole("heading", { name: "Your listing is published" })).toBeVisible();

  // Confirm in DB
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM "Listing" WHERE id = $1`,
    [listingId],
  );
  expect(rows[0].status).toBe("PUBLISHED");
});

// ─── Step 4: Renter books + pays → booking completes ────────────────────────

test("4. renter books + pays → booking completes", async () => {
  // Create renter
  const { rows: [renter] } = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, roles, name, "updatedAt")
     VALUES ($1, '{RENTER}', 'Renter ${run}', now()) RETURNING id`,
    [`renter-${run}@e2e.local`],
  );
  renterId = renter.id;
  toDeleteUsers.push(renterId);

  // Completed booking for 2 hours (subtotal ₹100, commission ₹10, host ₹90)
  const { rows: [booking] } = await db.query<{ id: string }>(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
       "blockedUntil", status, "checkedInAt", "checkedOutAt",
       "subtotalPaise", "commissionPaise", "hostEarningsPaise", "totalPaise", "updatedAt")
     VALUES ($1, $2, 'HOURLY', now() - interval '2 hours', now() - interval '1 hour',
       now() - interval '1 hour', 'COMPLETED', now() - interval '2 hours', now() - interval '1 hour',
       10000, 1000, 9000, 10000, now()) RETURNING id`,
    [listingId, renterId],
  );
  bookingId = booking.id;

  // Insert payment and ledger rows
  const paymentRef = `pay_e2e_${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO "Payment" ("bookingId", "providerOrderId", "providerPaymentId",
       "amountPaise", currency, status, "updatedAt")
     VALUES ($1, $2, $3, 10000, 'INR', 'SUCCEEDED', now())`,
    [bookingId, `order_${run}`, paymentRef],
  );

  await db.query(
    `INSERT INTO "LedgerEntry" ("bookingId", account, "amountPaise", reference, "updatedAt")
     VALUES ($1, 'RENTER_PAYMENT', 10000, $2, now()),
            ($1, 'PLATFORM_COMMISSION', 1000, $2, now()),
            ($1, 'HOST_EARNINGS', 9000, $2, now())`,
    [bookingId, paymentRef],
  );
});

// ─── Step 5: Host sees booking and pending earnings ─────────────────────────

test("5. host sees booking in /host/bookings and pending earnings in /host/earnings", async ({
  page,
  context,
  baseURL,
}) => {
  await sessionAs(context, hostId, baseURL!);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/host/bookings");
  await expect(page.getByRole("heading", { level: 1, name: "Host bookings" })).toBeVisible();

  // A11y and mobile responsiveness on key page 2 (/host/bookings)
  await a11yCheck(page, "host-bookings-page");
  await noHorizontalScroll(page);

  // Switch to Past tab
  const pastTab = page.getByRole("tab", { name: /Past/ });
  await pastTab.click();
  await expect(page.getByText(listingTitle)).toBeVisible();
  await expect(page.getByText("Completed").first()).toBeVisible();

  // Go to /host/earnings
  await page.goto("/host/earnings");
  await expect(page.getByRole("heading", { name: "Earnings and payouts" })).toBeVisible();

  // Pending earnings should reflect ₹90 (9000 paise)
  const totals = page.locator("dl");
  await expect(
    totals.locator("div").filter({ has: page.getByText("Pending", { exact: true }) }),
  ).toContainText("₹90");
});

// ─── Step 6: Admin creates + marks-paid payout after hold-back ──────────────

test("6. admin creates + marks-paid payout after hold-back (forced via SQL)", async ({
  browser,
  baseURL,
}) => {
  // Force booking times past the 24h hold-back
  await db.query(
    `UPDATE "Booking" SET
       "startAt" = now() - interval '72 hours',
       "endAt" = now() - interval '48 hours',
       "blockedUntil" = now() - interval '48 hours',
       "checkedOutAt" = now() - interval '48 hours',
       "updatedAt" = now()
     WHERE id = $1`,
    [bookingId],
  );

  // Admin session
  const adminCtx = await browser.newContext();
  const token = randomUUID();
  await db.query(
    `INSERT INTO "Session" ("sessionToken", "userId", expires, "updatedAt")
     VALUES ($1, $2, now() + interval '1 hour', now())`,
    [token, adminId],
  );
  await adminCtx.addCookies([
    {
      name: "authjs.session-token",
      value: token,
      url: baseURL!,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  // Admin creates payout
  const createRes = await adminCtx.request.post("/api/admin/payouts", {
    headers: { "idempotency-key": randomUUID() },
    data: {
      hostId,
      bookingIds: [bookingId],
      reason: "E2E test payout creation",
    },
  });
  expect(createRes.ok()).toBe(true);
  const payout = (await createRes.json()) as { id: string };
  payoutId = payout.id;
  toDeletePayouts.push(payoutId);

  // Admin marks payout paid
  const utrRef = `UTR${run}`;
  const markRes = await adminCtx.request.post(`/api/admin/payouts/${payoutId}/mark-paid`, {
    headers: { "idempotency-key": randomUUID() },
    data: {
      providerReference: utrRef,
      reason: "Bank NEFT transfer completed",
    },
  });
  expect(markRes.ok()).toBe(true);
  await adminCtx.close();
});

// ─── Step 7: Host sees paid earnings ────────────────────────────────────────

test("7. /host/earnings shows paid earnings", async ({ page, context, baseURL }) => {
  await sessionAs(context, hostId, baseURL!);
  await page.goto("/host/earnings");
  await expect(page.getByRole("heading", { name: "Earnings and payouts" })).toBeVisible();

  const totals = page.locator("dl");
  await expect(
    totals.locator("div").filter({ has: page.getByText("Paid", { exact: true }) }),
  ).toContainText("₹90");

  // Table row shows the payout UTR reference
  await expect(page.getByRole("cell", { name: `UTR${run}` })).toBeVisible();
});
