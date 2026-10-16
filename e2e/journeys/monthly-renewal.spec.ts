import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as baseExpect, type Page, test } from "@playwright/test";
import pg from "pg";
import { TZDate } from "@date-fns/tz";
import { addMonths } from "date-fns";

try {
  process.loadEnvFile(".env");
} catch {}

const APP_TIMEZONE = "Asia/Kolkata";

function startOfDayIST(date: Date): Date {
  const localDate = new TZDate(date, APP_TIMEZONE);
  return new Date(
    new TZDate(
      localDate.getFullYear(),
      localDate.getMonth(),
      localDate.getDate(),
      APP_TIMEZONE,
    ).getTime(),
  );
}

function monthlyTermEnd(startAt: Date): Date {
  return new Date(addMonths(new TZDate(startAt, APP_TIMEZONE), 1).getTime());
}

const expect = baseExpect.configure({ timeout: 30_000 });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const KEY_SECRET = "e2e-razorpay-key-secret-not-real";
const API_PORT = Number(process.env.E2E_PORT ?? 3000) + 1000;

/** Minimal fake Razorpay API server */
async function ensureFakeRazorpayApi() {
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/health`, { signal: AbortSignal.timeout(500) });
    if (res.ok) return;
  } catch {}

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.end("ok");
      return;
    }
    const json = (body: unknown) =>
      res.setHeader("content-type", "application/json").end(JSON.stringify(body));
    if (req.method === "POST" && req.url === "/v1/orders") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { amount, currency } = JSON.parse(raw) as { amount: number; currency: string };
        json({
          id: `order_${amount}_${Date.now().toString(36)}`,
          amount,
          currency,
          status: "created",
        });
      });
      return;
    }
    const m = req.url?.match(/^\/v1\/payments\/(pay_(order_(\d+)_\w+))$/);
    if (req.method === "GET" && m)
      return json({
        id: m[1],
        order_id: m[2],
        amount: Number(m[3]),
        currency: "INR",
        status: "captured",
      });
    res.statusCode = 404;
    json({ error: { code: "BAD_REQUEST_ERROR" } });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      e.code === "EADDRINUSE" ? resolve() : reject(e),
    );
    server.listen(API_PORT, "127.0.0.1", () => {
      server.unref();
      resolve();
    });
  });
}

const FAKE_CHECKOUT_JS = `
window.Razorpay = function (opts) {
  this.on = function () {};
  this.open = async function () {
    const paymentId = "pay_" + opts.order_id;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(${JSON.stringify(KEY_SECRET)}),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(opts.order_id + "|" + paymentId));
    const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
    opts.handler({ razorpay_order_id: opts.order_id, razorpay_payment_id: paymentId, razorpay_signature: hex });
  };
};`;

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
let agreementId: string;
let term1BookingId: string;
let term2BookingId: string;
let conflictBookingId: string;

let term1Start: Date;
let term1End: Date;

const listingTitle = `Monthly Spot ${run}`;

const toDeleteUsers: string[] = [];
const toDeleteListings: string[] = [];
const toDeleteAgreements: string[] = [];

test.beforeAll(async () => {
  await ensureFakeRazorpayApi();

  // Create host
  const { rows: [host] } = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, roles, "hostVerificationStatus", name, "updatedAt")
     VALUES ($1, '{HOST,RENTER}', 'VERIFIED', 'Monthly Host ${run}', now()) RETURNING id`,
    [`host-monthly-${run}@e2e.local`],
  );
  hostId = host.id;
  toDeleteUsers.push(hostId);

  // Create published listing in Pune offering monthly rentals
  const { rows: [listing] } = await db.query<{ id: string }>(
    `INSERT INTO "Listing" (
       "hostId", title, description, locality, city,
       lat, lng, "approxLat", "approxLng", "spaceType",
       address, "accessInstructions", "hostRules",
       "hourlyPaise", "monthlyPaise", "cancellationPolicy", "vehicleTypes", "maxHeightCm",
       "status", "hostAttestedAt", "updatedAt"
     ) VALUES (
       $1, $2, 'Listing for monthly renewal test', 'Baner', 'Pune',
       18.5590, 73.7868, 18.56, 73.79, 'DRIVEWAY',
       'Plot 12, Baner Road, Pune', 'Gate code 9988', 'Quiet parking only',
       5000, 500000, 'standard', '{"SEDAN"}', 210,
       'PUBLISHED', now(), now()
     ) RETURNING id`,
    [hostId, listingTitle],
  );
  listingId = listing.id;
  toDeleteListings.push(listingId);

  // Add 24/7 availability rules
  await db.query(
    `INSERT INTO "AvailabilityRule" ("listingId", weekday, "startMinute", "endMinute", "updatedAt")
     VALUES ($1, 0, 0, 1440, now()),
            ($1, 1, 0, 1440, now()),
            ($1, 2, 0, 1440, now()),
            ($1, 3, 0, 1440, now()),
            ($1, 4, 0, 1440, now()),
            ($1, 5, 0, 1440, now()),
            ($1, 6, 0, 1440, now())`,
    [listingId],
  );

  // Create renter
  const { rows: [renter] } = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, roles, name, "updatedAt")
     VALUES ($1, '{RENTER}', 'Monthly Renter ${run}', now()) RETURNING id`,
    [`renter-monthly-${run}@e2e.local`],
  );
  renterId = renter.id;
  toDeleteUsers.push(renterId);

  // Create vehicle for renter
  const regNumber = `MH12MN${Math.floor(1000 + Math.random() * 8999)}`;
  const { rows: [vehicle] } = await db.query<{ id: string }>(
    `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
     VALUES ($1, $2, 'SEDAN', 'City', now()) RETURNING id`,
    [renterId, regNumber],
  );
  vehicleId = vehicle.id;

  // Dates for Term 1 (starts at startOfDayIST today, ends at monthlyTermEnd)
  term1Start = startOfDayIST(new Date());
  term1End = monthlyTermEnd(term1Start);

  // Create active MonthlyAgreement
  const { rows: [agreement] } = await db.query<{ id: string }>(
    `INSERT INTO "MonthlyAgreement" (
       "renterId", "listingId", "vehicleId", "monthlyPaise", currency,
       "startAt", "currentTermStartAt", "currentTermEndAt", "renewalDueAt",
       status, "noticePeriodDays", "updatedAt"
     ) VALUES (
       $1, $2, $3, 500000, 'INR',
       $4, $4, $5, $5,
       'ACTIVE', 7, now()
     ) RETURNING id`,
    [renterId, listingId, vehicleId, term1Start, term1End],
  );
  agreementId = agreement.id;
  toDeleteAgreements.push(agreementId);

  // Create confirmed initial term booking
  const { rows: [term1Booking] } = await db.query<{ id: string }>(
    `INSERT INTO "Booking" (
       "listingId", "renterId", "vehicleId", "rentalType",
       "startAt", "endAt", "blockedUntil", status,
       "monthlyAgreementId", "subtotalPaise", "commissionPaise", "hostEarningsPaise", "totalPaise",
       "updatedAt"
     ) VALUES (
       $1, $2, $3, 'MONTHLY',
       $4, $5, $5, 'ACTIVE',
       $6, 500000, 50000, 450000, 500000,
       now()
     ) RETURNING id`,
    [listingId, renterId, vehicleId, term1Start, term1End, agreementId],
  );
  term1BookingId = term1Booking.id;

  // Insert payment and ledger for term 1
  const paymentRef = `pay_mon_${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO "Payment" ("bookingId", "providerOrderId", "providerPaymentId", "amountPaise", currency, status, "updatedAt")
     VALUES ($1, $2, $3, 500000, 'INR', 'SUCCEEDED', now())`,
    [term1BookingId, `order_m1_${run}`, paymentRef],
  );
  await db.query(
    `INSERT INTO "LedgerEntry" ("bookingId", account, "amountPaise", reference, "updatedAt")
     VALUES ($1, 'RENTER_PAYMENT', 500000, $2, now()),
            ($1, 'PLATFORM_COMMISSION', 50000, $2, now()),
            ($1, 'HOST_EARNINGS', 450000, $2, now())`,
    [term1BookingId, paymentRef],
  );
});

test.afterAll(async () => {
  const listIds = toDeleteListings.length ? toDeleteListings : ["00000000-0000-0000-0000-000000000000"];
  const userIds = toDeleteUsers.length ? toDeleteUsers : ["00000000-0000-0000-0000-000000000000"];
  const agreeIds = toDeleteAgreements.length ? toDeleteAgreements : ["00000000-0000-0000-0000-000000000000"];

  await db.query(
    `DELETE FROM "Job" WHERE payload->>'agreementId' = ANY($1::text[])`,
    [agreeIds],
  );
  await db.query(
    `DELETE FROM "LedgerEntry" WHERE "bookingId" IN
       (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]) OR "renterId" = ANY($2::uuid[]))`,
    [listIds, userIds],
  );
  await db.query(
    `DELETE FROM "Payment" WHERE "bookingId" IN
       (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]) OR "renterId" = ANY($2::uuid[]))`,
    [listIds, userIds],
  );
  await db.query(
    `DELETE FROM "Booking" WHERE "listingId" = ANY($1::uuid[]) OR "renterId" = ANY($2::uuid[])`,
    [listIds, userIds],
  );
  await db.query(
    `DELETE FROM "MonthlyAgreement" WHERE id = ANY($1::uuid[])`,
    [agreeIds],
  );
  if (toDeleteListings.length) {
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

test.beforeEach(async ({ page }) => {
  await ensureFakeRazorpayApi();
  await page.route("https://checkout.razorpay.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: FAKE_CHECKOUT_JS }),
  );
});

// ─── Step 1: Conflicting short-term booking blocks renewal ───────────────────

test("1. conflicting short-term booking in next month blocks renewal with clear message", async ({
  page,
  context,
  baseURL,
}) => {
  await sessionAs(context, renterId, baseURL!);

  // Insert conflicting short-term booking in the next month window
  const conflictStart = new Date(term1End.getTime() + 2 * 3600 * 1000);
  const conflictEnd = new Date(conflictStart.getTime() + 2 * 3600 * 1000);

  const { rows: [conflict] } = await db.query<{ id: string }>(
    `INSERT INTO "Booking" (
       "listingId", "renterId", "rentalType",
       "startAt", "endAt", "blockedUntil", status,
       "subtotalPaise", "commissionPaise", "hostEarningsPaise", "totalPaise",
       "updatedAt"
     ) VALUES (
       $1, $2, 'HOURLY',
       $3, $4, $4, 'CONFIRMED',
       10000, 1000, 9000, 10000,
       now()
     ) RETURNING id`,
    [listingId, renterId, conflictStart, conflictEnd],
  );
  conflictBookingId = conflict.id;

  // Visit booking page for initial monthly term
  await page.goto(`/bookings/${term1BookingId}`);
  await expect(page.getByRole("heading", { name: listingTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Monthly rental" })).toBeVisible();

  // Key page 1 a11y & mobile responsiveness
  await a11yCheck(page, "monthly-booking-detail-page");
  await noHorizontalScroll(page);

  // Attempt renewal with conflicting booking in place
  const renewBtn = page.getByRole("button", { name: "Renew for next month" });
  await expect(renewBtn).toBeVisible();
  await renewBtn.click();

  // Clear message toast appears
  await expect(
    page.getByText("This space is no longer available for that time"),
  ).toBeVisible({ timeout: 15_000 });

  // Remove the conflicting short-term booking so renewal can succeed in step 2
  await db.query(`DELETE FROM "Booking" WHERE id = $1`, [conflictBookingId]);
});

// ─── Step 2: Renew → Checkout for next IST month → Pay → Both terms visible ──

test("2. renew → checkout for next IST month → pay → both terms visible", async ({
  page,
  context,
  baseURL,
}) => {
  // Clean up any lingering holds from previous retries
  await db.query(
    `DELETE FROM "Booking" WHERE "monthlyAgreementId" = $1 AND status = 'PENDING_PAYMENT'`,
    [agreementId],
  );

  await sessionAs(context, renterId, baseURL!);

  // Intercept Razorpay Checkout before any page navigation
  await page.route("https://checkout.razorpay.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: FAKE_CHECKOUT_JS,
    }),
  );

  await page.goto(`/bookings/${term1BookingId}`);
  await expect(page.getByRole("heading", { name: listingTitle })).toBeVisible();
  // Wait for React hydration (countdown only renders client-side after hydration)
  await expect(page.getByTestId("countdown")).toBeVisible();

  // Click renew
  const renewBtn = page.getByRole("button", { name: "Renew for next month" });
  await expect(renewBtn).toBeVisible();
  await renewBtn.click();

  // Success toast and redirects to checkout for next month
  await expect(page).toHaveURL(/\/checkout\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  term2BookingId = page.url().split("/").pop()!;

  // Refresh to checkout page to ensure clean state and fresh script execution
  await page.goto(`/checkout/${term2BookingId}`);
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();

  // Pay on checkout (wait for Razorpay script to load and enable button)
  const payBtn = page.getByRole("button", { name: /Pay ₹/ });
  await expect(payBtn).toBeVisible({ timeout: 15_000 });
  await expect(payBtn).toBeEnabled({ timeout: 30_000 });
  await payBtn.click();

  // Booking confirmed alert appears
  await expect(page.getByText("Booking confirmed")).toBeVisible({ timeout: 45_000 });
  await page.getByRole("link", { name: "View booking and access details" }).click();
  await expect(page).toHaveURL(`/bookings/${term2BookingId}`, { timeout: 15_000 });

  // Visit /bookings list page to see both terms
  await page.goto("/bookings");
  await expect(page.getByRole("heading", { level: 1, name: "Your bookings" })).toBeVisible();

  // Key page 2 a11y & mobile responsiveness
  await a11yCheck(page, "renter-bookings-list-page");
  await noHorizontalScroll(page);

  // Both terms are visible via API contract
  const agreeRes = await context.request.get(`/api/monthly/${agreementId}`);
  expect(agreeRes.ok()).toBe(true);
  const agreementDetail = (await agreeRes.json()) as { terms: Array<{ id: string; status: string }> };
  expect(agreementDetail.terms.length).toBe(2);
  const termIds = agreementDetail.terms.map((t) => t.id);
  expect(termIds).toContain(term1BookingId);
  expect(termIds).toContain(term2BookingId);
});
