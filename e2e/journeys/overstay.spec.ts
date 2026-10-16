import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as baseExpect, type Page, test } from "@playwright/test";
import pg from "pg";

try {
  process.loadEnvFile(".env");
} catch {}

const expect = baseExpect.configure({ timeout: 30_000 });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function a11yCheck(page: Page, label: string) {
  const axe = new AxeBuilder({ page }).disableRules(["color-contrast"]);
  const results = await axe.analyze();
  const violations = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    violations,
    `A11y violations (${violations.length}) on ${label}: ${JSON.stringify(
      violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
      null,
      2,
    )}`,
  ).toEqual([]);
}

async function noHorizontalScroll(page: Page) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(
    scrollWidth,
    `Page has horizontal overflow (${scrollWidth} > ${clientWidth})`,
  ).toBeLessThanOrEqual(clientWidth);
}

async function sessionAs(
  context: { addCookies: (cookies: Array<{ name: string; value: string; url: string; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None" }>) => Promise<void> },
  userId: string,
  baseURL: string,
) {
  const token = randomUUID();
  await db.query(
    `INSERT INTO "Session" ("sessionToken", "userId", expires, "updatedAt")
     VALUES ($1, $2, now() + interval '1 hour', now())`,
    [token, userId],
  );
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

const run = randomUUID().replace(/-/g, "").slice(0, 8);
let hostId: string;
let renterId: string;
let vehicleId: string;
let listingId: string;
let bookingId: string;
let endAtIso: string;

const listingTitle = `Overstay Spot ${run}`;

const toDeleteUsers: string[] = [];
const toDeleteListings: string[] = [];

test.beforeAll(async () => {
  // Create host
  const { rows: [host] } = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, roles, "hostVerificationStatus", name, "updatedAt")
     VALUES ($1, '{HOST,RENTER}', 'VERIFIED', 'Overstay Host ${run}', now()) RETURNING id`,
    [`host-overstay-${run}@e2e.local`],
  );
  hostId = host.id;
  toDeleteUsers.push(hostId);

  // Create renter
  const { rows: [renter] } = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, roles, name, "updatedAt")
     VALUES ($1, '{RENTER}', 'Overstay Renter ${run}', now()) RETURNING id`,
    [`renter-overstay-${run}@e2e.local`],
  );
  renterId = renter.id;
  toDeleteUsers.push(renterId);

  // Add renter vehicle
  const { rows: [vehicle] } = await db.query<{ id: string }>(
    `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
     VALUES ($1, 'MH12OV${run.slice(0, 4)}', 'SEDAN', 'OverstayCar', now()) RETURNING id`,
    [renterId],
  );
  vehicleId = vehicle.id;

  // Create published listing in Pune
  const { rows: [listing] } = await db.query<{ id: string }>(
    `INSERT INTO "Listing" (
       "hostId", title, description, locality, city,
       lat, lng, "approxLat", "approxLng", "spaceType",
       address, "accessInstructions", "hostRules",
       "hourlyPaise", "cancellationPolicy", "vehicleTypes", "maxHeightCm",
       "status", "hostAttestedAt", "updatedAt"
     ) VALUES (
       $1, $2, 'Overstay e2e journey listing', 'Kothrud', 'Pune',
       18.5074, 73.8077, 18.51, 73.81, 'DRIVEWAY',
       'Plot 88, Kothrud, Pune', 'Park in spot 88', 'Please leave on time',
       10000, 'FLEXIBLE', '{SEDAN}', 210,
       'PUBLISHED', now(), now()
     ) RETURNING id`,
    [hostId, listingTitle],
  );
  listingId = listing.id;
  toDeleteListings.push(listingId);

  // Insert availability rules (Mon-Sun 0..1440)
  for (let w = 0; w <= 6; w++) {
    await db.query(
      `INSERT INTO "AvailabilityRule" ("listingId", weekday, "startMinute", "endMinute", "updatedAt")
       VALUES ($1, $2, 0, 1440, now())`,
      [listingId, w],
    );
  }

  // Create ACTIVE booking whose endAt is in the past (e.g. ended 15 minutes ago, checked in 2 hours ago)
  const { rows: [booking] } = await db.query<{ id: string; endAt: Date }>(
    `INSERT INTO "Booking" (
       "listingId", "renterId", "vehicleId", "rentalType",
       "startAt", "endAt", "blockedUntil", status, "checkedInAt",
       "subtotalPaise", "commissionPaise", "hostEarningsPaise", "totalPaise",
       "updatedAt"
     ) VALUES (
       $1, $2, $3, 'HOURLY',
       now() - interval '2 hours', now() - interval '15 minutes', now() - interval '15 minutes',
       'ACTIVE', now() - interval '2 hours',
       20000, 2000, 18000, 20000,
       now()
     ) RETURNING id, "endAt"`,
    [listingId, renterId, vehicleId],
  );
  bookingId = booking.id;
  endAtIso = booking.endAt.toISOString();

  // Create payment and ledger entries
  const paymentRef = `pay_ov_${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO "Payment" ("bookingId", "providerOrderId", "providerPaymentId", "amountPaise", currency, status, "updatedAt")
     VALUES ($1, $2, $3, 20000, 'INR', 'SUCCEEDED', now())`,
    [bookingId, `order_ov_${run}`, paymentRef],
  );
  await db.query(
    `INSERT INTO "LedgerEntry" ("bookingId", account, "amountPaise", reference, "updatedAt")
     VALUES ($1, 'RENTER_PAYMENT', 20000, $2, now()),
            ($1, 'PLATFORM_COMMISSION', 2000, $2, now()),
            ($1, 'HOST_EARNINGS', 18000, $2, now())`,
    [bookingId, paymentRef],
  );
});

test.afterAll(async () => {
  const listIds = toDeleteListings.length ? toDeleteListings : ["00000000-0000-0000-0000-000000000000"];
  const userIds = toDeleteUsers.length ? toDeleteUsers : ["00000000-0000-0000-0000-000000000000"];
  const bId = bookingId ?? "00000000-0000-0000-0000-000000000000";

  await db.query(
    `DELETE FROM "Job" WHERE payload->>'bookingId' = $1 OR payload->>'bookingId' IN
       (SELECT id::text FROM "Booking" WHERE "listingId" = ANY($2::uuid[]) OR "renterId" = ANY($3::uuid[]))`,
    [bId, listIds, userIds],
  );
  await db.query(
    `DELETE FROM "OverstayIncident" WHERE "bookingId" = $1 OR "bookingId" IN
       (SELECT id FROM "Booking" WHERE "listingId" = ANY($2::uuid[]) OR "renterId" = ANY($3::uuid[]))`,
    [bId, listIds, userIds],
  );
  await db.query(
    `DELETE FROM "SessionEvent" WHERE "bookingId" = $1 OR "bookingId" IN
       (SELECT id FROM "Booking" WHERE "listingId" = ANY($2::uuid[]) OR "renterId" = ANY($3::uuid[]))`,
    [bId, listIds, userIds],
  );
  await db.query(
    `DELETE FROM "LedgerEntry" WHERE "bookingId" = $1 OR "bookingId" IN
       (SELECT id FROM "Booking" WHERE "listingId" = ANY($2::uuid[]) OR "renterId" = ANY($3::uuid[]))`,
    [bId, listIds, userIds],
  );
  await db.query(
    `DELETE FROM "Payment" WHERE "bookingId" = $1 OR "bookingId" IN
       (SELECT id FROM "Booking" WHERE "listingId" = ANY($2::uuid[]) OR "renterId" = ANY($3::uuid[]))`,
    [bId, listIds, userIds],
  );
  await db.query(
    `DELETE FROM "Booking" WHERE id = $1 OR "listingId" = ANY($2::uuid[]) OR "renterId" = ANY($3::uuid[])`,
    [bId, listIds, userIds],
  );
  if (toDeleteListings.length) {
    await db.query(
      `DELETE FROM "AvailabilityRule" WHERE "listingId" = ANY($1::uuid[])`,
      [toDeleteListings],
    );
    await db.query(`DELETE FROM "Listing" WHERE id = ANY($1::uuid[])`, [toDeleteListings]);
  }
  if (toDeleteUsers.length) {
    await db.query(`DELETE FROM "Vehicle" WHERE "userId" = ANY($1::uuid[])`, [toDeleteUsers]);
    await db.query(`DELETE FROM "Notification" WHERE "userId" = ANY($1::uuid[])`, [toDeleteUsers]);
    await db.query(
      `DELETE FROM "AuditLog" WHERE "actorId" = ANY($1::uuid[]) OR "targetId" = ANY($2::text[])`,
      [toDeleteUsers, toDeleteUsers],
    );
    await db.query(`DELETE FROM "User" WHERE id = ANY($1::uuid[])`, [toDeleteUsers]);
  }
  await db.end();
});

// ─── Step 1: Active past endAt → run grace job → GRACE_PERIOD banner ─────────

test("1. active booking past endAt → run startGrace job via cron → GRACE_PERIOD banner for renter", async ({
  page,
  context,
  baseURL,
}) => {
  // Insert due sessions.startGrace job into queue
  await db.query(
    `INSERT INTO "Job" (id, type, payload, status, "runAt", "maxAttempts", "updatedAt")
     VALUES (gen_random_uuid(), 'sessions.startGrace', $1::jsonb, 'PENDING', now() - interval '10 minutes', 5, now())`,
    [JSON.stringify({ bookingId, endAt: endAtIso })],
  );

  // Trigger cron tick until status becomes GRACE_PERIOD
  for (let attempt = 0; attempt < 10; attempt++) {
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM "Booking" WHERE id = $1`,
      [bookingId],
    );
    if (rows[0]?.status === "GRACE_PERIOD") break;
    const cronRes = await context.request.post("/api/cron/tick", {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    expect(cronRes.ok()).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
  }

  // DB booking status moved to GRACE_PERIOD
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM "Booking" WHERE id = $1`,
    [bookingId],
  );
  expect(rows[0].status).toBe("GRACE_PERIOD");

  // Renter visits booking detail page
  await sessionAs(context, renterId, baseURL!);
  await page.goto(`/bookings/${bookingId}`);
  await expect(page.getByRole("heading", { name: listingTitle })).toBeVisible();

  // Banner for GRACE_PERIOD appears
  await expect(page.getByText("Your booked time has ended")).toBeVisible();
  await expect(page.getByText(/Please move your vehicle by/)).toBeVisible();

  // Key page 1 a11y & mobile responsiveness
  await a11yCheck(page, "renter-grace-period-booking-page");
  await noHorizontalScroll(page);
});

// ─── Step 2: Grace expired job → OVERSTAY banner for renter ───────────────────

test("2. run graceExpired job via cron → OVERSTAY banner for renter", async ({
  page,
  context,
  baseURL,
}) => {
  // Insert due sessions.graceExpired job into queue
  await db.query(
    `INSERT INTO "Job" (id, type, payload, status, "runAt", "maxAttempts", "updatedAt")
     VALUES (gen_random_uuid(), 'sessions.graceExpired', $1::jsonb, 'PENDING', now() - interval '5 minutes', 5, now())`,
    [JSON.stringify({ bookingId, endAt: endAtIso })],
  );

  // Trigger cron tick until status becomes OVERSTAY
  for (let attempt = 0; attempt < 10; attempt++) {
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM "Booking" WHERE id = $1`,
      [bookingId],
    );
    if (rows[0]?.status === "OVERSTAY") break;
    const cronRes = await context.request.post("/api/cron/tick", {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    expect(cronRes.ok()).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
  }

  // DB booking status moved to OVERSTAY
  const { rows: bRows } = await db.query<{ status: string }>(
    `SELECT status FROM "Booking" WHERE id = $1`,
    [bookingId],
  );
  expect(bRows[0].status).toBe("OVERSTAY");

  // OverstayIncident created and OPEN in DB
  const { rows: incRows } = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM "OverstayIncident" WHERE "bookingId" = $1`,
    [bookingId],
  );
  expect(incRows.length).toBe(1);
  expect(incRows[0].status).toBe("OPEN");

  // Renter visits booking detail page
  await sessionAs(context, renterId, baseURL!);
  await page.goto(`/bookings/${bookingId}`);
  await expect(page.getByRole("heading", { name: listingTitle })).toBeVisible();

  // Banner for OVERSTAY appears
  await expect(page.getByText("The grace period has ended")).toBeVisible();
  await expect(
    page.getByText(/We've let the host know, and support will review what happened/),
  ).toBeVisible();

  // "I've left" button is available
  await expect(page.getByRole("button", { name: "I've left" })).toBeVisible();
});

// ─── Step 3: Host sees the incident in /host/bookings ─────────────────────────

test("3. host sees the incident in /host/bookings", async ({
  page,
  context,
  baseURL,
}) => {
  await sessionAs(context, hostId, baseURL!);
  await page.goto("/host/bookings");
  await expect(page.getByRole("heading", { name: "Host bookings" })).toBeVisible();

  // Key page 2 a11y & mobile responsiveness
  await a11yCheck(page, "host-bookings-incident-page");
  await noHorizontalScroll(page);

  // Host card shows booking and overstay indicator
  await expect(page.getByText(listingTitle)).toBeVisible();
  await expect(page.getByText("Past grace period")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm departure" })).toBeVisible();
});

// ─── Step 4: Checkout resolves incident with no fee shown ─────────────────────

test("4. checkout resolves incident with no fee shown", async ({
  page,
  context,
  baseURL,
}) => {
  await sessionAs(context, renterId, baseURL!);
  await page.goto(`/bookings/${bookingId}`);
  await expect(page.getByRole("heading", { name: listingTitle })).toBeVisible();

  // Renter records departure via "I've left"
  const leaveBtn = page.getByRole("button", { name: "I've left" });
  await expect(leaveBtn).toBeVisible();
  await leaveBtn.click();

  // Toast confirmation and booking status update
  await expect(page.getByText("Thanks! Your departure is recorded.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 15_000 });

  // DB verification: Booking is COMPLETED with checkout time set
  const { rows: bRows } = await db.query<{ status: string; checkedOutAt: Date | null }>(
    `SELECT status, "checkedOutAt" FROM "Booking" WHERE id = $1`,
    [bookingId],
  );
  expect(bRows[0].status).toBe("COMPLETED");
  expect(bRows[0].checkedOutAt).not.toBeNull();

  // DB verification: OverstayIncident is RESOLVED with "departed" and no penalty
  const { rows: incRows } = await db.query<{
    status: string;
    resolution: string | null;
    resolvedAt: Date | null;
  }>(
    `SELECT status, resolution, "resolvedAt" FROM "OverstayIncident" WHERE "bookingId" = $1`,
    [bookingId],
  );
  expect(incRows[0].status).toBe("RESOLVED");
  expect(incRows[0].resolution).toBe("departed");
  expect(incRows[0].resolvedAt).not.toBeNull();

  // Receipt verification: Parking ₹200, Total ₹200, and NO fee charged for overstay
  const receiptHeading = page.getByRole("heading", { name: "Receipt" });
  await expect(receiptHeading).toBeVisible();
  await expect(page.getByText("Parking", { exact: true })).toBeVisible();
  await expect(page.getByText("Total", { exact: true })).toBeVisible();
  await expect(page.getByText("₹200", { exact: true })).toHaveCount(2);

  // Confirm terms state no overstay fee is charged
  await expect(page.getByText("No overstay fee is charged", { exact: false })).toBeVisible();
});
