import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers/session";

// FR-06 happy path through the real UI and API. Nothing real is called: the dev server's
// Razorpay SDK points at a fake API on E2E_PORT + 1000 (playwright.config.ts webServer.env),
// and checkout.razorpay.com is route-mocked with a tiny Razorpay that "pays" at once and
// signs the callback with the obviously-fake test key secret.

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
test.afterAll(() => db.end());
test.describe.configure({ timeout: 120_000 });
const SLOW = { timeout: 30_000 };

const KEY_SECRET = "e2e-razorpay-key-secret-not-real"; // = webServer.env RAZORPAY_KEY_SECRET
const API_PORT = Number(process.env.E2E_PORT ?? 3000) + 1000;

/**
 * Stateless fake of the two Razorpay API calls the flow makes, so either Playwright
 * project's worker can serve both. Order ids carry the amount; payment ids carry the order.
 */
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
    const m = req.url?.match(/^\/v1\/payments\/pay_(order_(\d+)_\w+)$/);
    if (req.method === "GET" && m)
      return json({
        id: `pay_${m[1]}`,
        order_id: m[1],
        amount: Number(m[2]),
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

/** A fresh renter holding a published listing at a random far-future hour. */
async function heldBooking(userId: string) {
  const { rows: listings } = await db.query<{ id: string }>(
    `SELECT id FROM "Listing" WHERE status = 'PUBLISHED' ORDER BY random() LIMIT 1`,
  );
  const hours = 24 * 400 + Math.floor(Math.random() * 24 * 3000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt", "blockedUntil",
       "holdExpiresAt", "subtotalPaise", "commissionPaise", "hostEarningsPaise", "totalPaise", "updatedAt")
     VALUES ($1, $2, 'HOURLY', date_trunc('hour', now()) + make_interval(hours => $3),
       date_trunc('hour', now()) + make_interval(hours => $3 + 1),
       date_trunc('hour', now()) + make_interval(hours => $3 + 1),
       now() + interval '10 minutes', 12000, 1200, 10800, 12000, now())
     RETURNING id`,
    [listings[0].id, userId, hours],
  );
  return rows[0].id;
}

test("pay: order → Razorpay Checkout → verified confirmation → confirmed page", async ({
  page,
  context,
  baseURL,
}) => {
  await ensureFakeRazorpayApi();
  await page.route("https://checkout.razorpay.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: FAKE_CHECKOUT_JS }),
  );
  const { userId } = await signIn(context, baseURL!);
  const bookingId = await heldBooking(userId);

  await page.goto(`/checkout/${bookingId}`);
  const pay = page.getByRole("button", { name: /^Pay ₹120/ });
  await expect(pay).toBeEnabled(SLOW);
  await pay.click();

  await expect(page.getByText("Booking confirmed")).toBeVisible(SLOW);
  const { rows } = await db.query<{ status: string; payment: string }>(
    `SELECT b.status, p.status AS payment FROM "Booking" b JOIN "Payment" p ON p."bookingId" = b.id
     WHERE b.id = $1`,
    [bookingId],
  );
  expect(rows).toEqual([{ status: "CONFIRMED", payment: "SUCCEEDED" }]);
  await expect(page.getByRole("link", { name: "View booking and access details" })).toBeVisible();
});
