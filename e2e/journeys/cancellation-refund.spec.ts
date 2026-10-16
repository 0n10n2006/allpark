import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as baseExpect, type Page, test } from "@playwright/test";
import pg from "pg";

try {
  process.loadEnvFile(".env");
} catch {}

const expect = baseExpect.configure({ timeout: 30_000 });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const KEY_SECRET = "e2e-razorpay-key-secret-not-real";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "e2e-razorpay-webhook-secret-not-real";
const API_PORT = Number(process.env.E2E_PORT ?? 3000) + 1000;

/** Minimal fake Razorpay API server */
async function ensureFakeRazorpayApi() {
  const server = createServer((req, res) => {
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
let bookingId: string;
let refundId: string;
let providerPaymentId: string;

const listingTitle = `Cancellation Spot ${run}`;

const toDeleteUsers: string[] = [];
const toDeleteListings: string[] = [];
const toDeleteEvents: string[] = [];

test.beforeAll(async () => {
  await ensureFakeRazorpayApi();

  // Create host
  const { rows: [host] } = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, roles, "hostVerificationStatus", name, "updatedAt")
     VALUES ($1, '{HOST,RENTER}', 'VERIFIED', 'Cancel Host ${run}', now()) RETURNING id`,
    [`host-cancel-${run}@e2e.local`],
  );
  hostId = host.id;
  toDeleteUsers.push(hostId);

  // Create published listing in Pune
  const { rows: [listing] } = await db.query<{ id: string }>(
    `INSERT INTO "Listing" (
       "hostId", title, description, locality, city,
       lat, lng, "approxLat", "approxLng", "spaceType",
       address, "accessInstructions", "hostRules",
       "hourlyPaise", "cancellationPolicy", "vehicleTypes", "maxHeightCm",
       "status", "hostAttestedAt", "updatedAt"
     ) VALUES (
       $1, $2, 'Listing for cancellation test', 'Kothrud', 'Pune',
       18.5074, 73.8077, 18.51, 73.81, 'DRIVEWAY',
       'Flat 401, Swapnasheel, Kothrud, Pune', 'Gate code 4321', 'Park inside line',
       10000, 'FLEXIBLE', '{"SEDAN"}', 210,
       'PUBLISHED', now(), now()
     ) RETURNING id`,
    [hostId, listingTitle],
  );
  listingId = listing.id;
  toDeleteListings.push(listingId);

  // Add 24/7 availability rule
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
     VALUES ($1, '{RENTER}', 'Cancel Renter ${run}', now()) RETURNING id`,
    [`renter-cancel-${run}@e2e.local`],
  );
  renterId = renter.id;
  toDeleteUsers.push(renterId);

  // Create vehicle for renter
  const regNumber = `MH12CN${Math.floor(1000 + Math.random() * 8999)}`;
  const { rows: [vehicle] } = await db.query<{ id: string }>(
    `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
     VALUES ($1, $2, 'SEDAN', 'City', now()) RETURNING id`,
    [renterId, regNumber],
  );
  vehicleId = vehicle.id;
});

test.afterAll(async () => {
  if (toDeleteEvents.length) {
    await db.query(`DELETE FROM "ProviderEvent" WHERE "eventId" = ANY($1::text[])`, [toDeleteEvents]);
  }
  const listIds = toDeleteListings.length ? toDeleteListings : ["00000000-0000-0000-0000-000000000000"];
  const userIds = toDeleteUsers.length ? toDeleteUsers : ["00000000-0000-0000-0000-000000000000"];

  await db.query(
    `DELETE FROM "Job" WHERE payload->>'refundId' IN
       (SELECT id::text FROM "Refund" WHERE "paymentId" IN
         (SELECT id FROM "Payment" WHERE "bookingId" IN
           (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]) OR "renterId" = ANY($2::uuid[]))))`,
    [listIds, userIds],
  );
  await db.query(
    `DELETE FROM "Refund" WHERE "paymentId" IN
       (SELECT id FROM "Payment" WHERE "bookingId" IN
         (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]) OR "renterId" = ANY($2::uuid[])))`,
    [listIds, userIds],
  );
  await db.query(
    `DELETE FROM "LedgerEntry" WHERE "bookingId" IN
       (SELECT id FROM "Booking" WHERE "listingId" = ANY($1::uuid[]) OR "renterId" = ANY($2::uuid[]))`,
    [listIds, userIds],
  );
  await db.query(
    `DELETE FROM "SessionEvent" WHERE "bookingId" IN
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

// ─── Step 1: Renter books and pays ──────────────────────────────────────────

test("1. renter books and pays for a future booking", async ({
  page,
  context,
  baseURL,
}) => {
  await sessionAs(context, renterId, baseURL!);

  // Hold a future 2-hour window (tomorrow)
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  tomorrow.setMinutes(0, 0, 0);
  const endTomorrow = new Date(tomorrow.getTime() + 2 * 3600 * 1000);

  // Quote via API
  const quoteRes = await context.request.post("/api/quotes", {
    data: {
      listingId,
      vehicleId,
      rentalType: "HOURLY",
      startAt: tomorrow.toISOString(),
      endAt: endTomorrow.toISOString(),
    },
  });
  expect(quoteRes.ok()).toBe(true);
  const quote = (await quoteRes.json()) as { id: string };

  // Hold booking via API
  const bookRes = await context.request.post("/api/bookings/hold", {
    headers: { "idempotency-key": randomUUID() },
    data: {
      quoteId: quote.id,
    },
  });
  expect(bookRes.ok()).toBe(true);
  const booking = (await bookRes.json()) as { id: string };
  bookingId = booking.id;

  // Intercept Razorpay Checkout
  await page.route("https://checkout.razorpay.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: FAKE_CHECKOUT_JS,
    }),
  );

  // Go to checkout and pay
  await page.goto(`/checkout/${bookingId}`);
  const payBtn = page.getByRole("button", { name: /Pay ₹/ });
  await expect(payBtn).toBeVisible({ timeout: 15_000 });
  await payBtn.click();

  // Booking confirmed alert appears
  await expect(page.getByText("Booking confirmed")).toBeVisible({ timeout: 45_000 });
  await page.getByRole("link", { name: "View booking and access details" }).click();

  // Redirects to confirmed booking page
  await expect(page).toHaveURL(`/bookings/${bookingId}`, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: listingTitle })).toBeVisible();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();

  // Key page 1 a11y & mobile responsiveness
  await a11yCheck(page, "confirmed-booking-page");
  await noHorizontalScroll(page);
});

// ─── Step 2: Renter cancels in UI with policy shown ──────────────────────────

test("2. renter cancels in the UI with policy shown → refund PENDING appears", async ({
  page,
  context,
  baseURL,
}) => {
  await sessionAs(context, renterId, baseURL!);
  await page.goto(`/bookings/${bookingId}`);
  await expect(page.getByRole("heading", { name: listingTitle })).toBeVisible();

  // Cancel booking trigger button
  const cancelBtn = page.getByRole("button", { name: "Cancel booking" });
  await expect(cancelBtn).toBeVisible();
  await cancelBtn.click();

  // Dialog opens showing cancellation policy terms
  const dialog = page.getByRole("dialog");
  await expect(page.getByRole("heading", { name: "Cancel this booking?" })).toBeVisible();
  await expect(dialog.getByText(/Full refund/)).toBeVisible();
  await expect(
    dialog.getByText("Any refund is processed separately and shown on this booking."),
  ).toBeVisible();

  // Confirm cancellation
  const confirmBtn = dialog.getByRole("button", { name: "Cancel booking" });
  await confirmBtn.click();

  // Booking becomes Cancelled with Refund pending badge
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Refund pending")).toBeVisible({ timeout: 15_000 });

  // Verify Refund row was created in DB
  const { rows: refundRows } = await db.query<{ id: string; status: string }>(
    `SELECT r.id, r.status FROM "Refund" r
     JOIN "Payment" p ON p.id = r."paymentId"
     WHERE p."bookingId" = $1`,
    [bookingId],
  );
  expect(refundRows.length).toBeGreaterThan(0);
  expect(refundRows[0].status).toBe("PENDING");
  refundId = refundRows[0].id;

  const { rows: paymentRows } = await db.query<{ providerPaymentId: string }>(
    `SELECT "providerPaymentId" FROM "Payment" WHERE "bookingId" = $1`,
    [bookingId],
  );
  providerPaymentId = paymentRows[0].providerPaymentId;
});

// ─── Step 3: Simulate refund webhook → refund SUCCEEDED shown ───────────────

test("3. simulate provider refund webhook → refund SUCCEEDED shown", async ({
  page,
  context,
  baseURL,
}) => {
  const eventId = `evt_rfnd_${randomUUID().replace(/-/g, "")}`;
  toDeleteEvents.push(eventId);

  const rawBody = JSON.stringify({
    entity: "event",
    event: "refund.processed",
    payload: {
      refund: {
        entity: {
          id: `rfnd_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
          payment_id: providerPaymentId,
          receipt: refundId,
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  const signature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

  const webhookRes = await context.request.post("/api/webhooks/razorpay", {
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": eventId,
    },
    data: rawBody,
  });
  expect(webhookRes.ok()).toBe(true);

  // Reload booking page to see updated refund status
  await sessionAs(context, renterId, baseURL!);
  await page.goto(`/bookings/${bookingId}`);
  await expect(page.getByText("Refunded")).toBeVisible({ timeout: 15_000 });

  // Key page 2 a11y & mobile responsiveness
  await a11yCheck(page, "refunded-booking-page");
  await noHorizontalScroll(page);
});
