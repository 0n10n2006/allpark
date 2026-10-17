import { expect, test } from "@playwright/test";
import pg from "pg";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
test.afterAll(() => db.end());
test.describe.configure({ timeout: 120_000 });
const SLOW = { timeout: 30_000 };

/** Creates a held booking for Riya on a published Pune listing. */
async function heldDemoBooking(userId: string) {
  const { rows: listings } = await db.query<{ id: string }>(
    `SELECT id FROM "Listing" WHERE status = 'PUBLISHED' ORDER BY random() LIMIT 1`,
  );
  const hours = 24 * 500 + Math.floor(Math.random() * 24 * 1000);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt", "blockedUntil",
       "holdExpiresAt", "subtotalPaise", "commissionPaise", "hostEarningsPaise", "totalPaise", "updatedAt")
     VALUES ($1, $2, 'HOURLY', date_trunc('hour', now()) + make_interval(hours => $3),
       date_trunc('hour', now()) + make_interval(hours => $3 + 2),
       date_trunc('hour', now()) + make_interval(hours => $3 + 2),
       now() + interval '10 minutes', 14000, 1400, 12600, 14000, now())
     RETURNING id`,
    [listings[0].id, userId, hours],
  );
  return rows[0].id;
}

test("demo: demo sign-in as Riya → book a listing → simulated pay → confirmed with access details", async ({
  page,
}) => {
  // 1. Navigate to demo sign-in page
  await page.goto("/dev/sign-in");
  await expect(page.getByText("Demo Sign-in")).toBeVisible(SLOW);
  await expect(page.getByText("Demo Mode Active")).toBeVisible();

  // 2. Click "Sign in as Riya"
  const signInButton = page.getByRole("button", { name: "Sign in as Riya" });
  await expect(signInButton).toBeVisible();
  await signInButton.click();

  // 3. User is signed in and redirected to explore (or home)
  await page.waitForURL((url) => !url.pathname.includes("/dev/sign-in"), SLOW);

  // Retrieve Riya's user ID from database
  const { rows: userRows } = await db.query<{ id: string }>(
    `SELECT id FROM "User" WHERE email = 'riya@parkshare.local'`,
  );
  expect(userRows.length).toBeGreaterThan(0);
  const riyaId = userRows[0].id;

  // 4. Create a held booking for Riya
  const bookingId = await heldDemoBooking(riyaId);

  // 5. Navigate to the checkout page
  await page.goto(`/checkout/${bookingId}`);

  // 6. Verify the demo simulated payment panel is displayed
  await expect(
    page.getByText("Simulated payment (demo mode, no real money)"),
  ).toBeVisible(SLOW);
  await expect(page.getByRole("button", { name: "Simulate failure" })).toBeVisible();

  // 7. Click the simulated Pay button
  const payButton = page.getByRole("button", { name: /^Pay ₹140/ });
  await expect(payButton).toBeEnabled();
  await payButton.click();

  // 8. Verify confirmation alert and link to access details
  await expect(page.getByText("Booking confirmed")).toBeVisible(SLOW);
  const detailsLink = page.getByRole("link", { name: "View booking and access details" });
  await expect(detailsLink).toBeVisible();

  // 9. Click through to view booking and access details
  await detailsLink.click();
  await page.waitForURL(`/bookings/${bookingId}`, SLOW);

  // 10. Verify access details ("Getting in", "Access instructions", address) are visible
  await expect(page.getByRole("heading", { name: "Getting in" })).toBeVisible(SLOW);
  await expect(page.getByText("Access instructions")).toBeVisible();

  // 11. Verify DB state: booking is CONFIRMED, payment is SUCCEEDED, ledger rows exist
  const { rows: bookingRows } = await db.query<{ status: string; paymentStatus: string }>(
    `SELECT b.status, p.status AS "paymentStatus"
     FROM "Booking" b
     JOIN "Payment" p ON p."bookingId" = b.id
     WHERE b.id = $1`,
    [bookingId],
  );
  expect(bookingRows).toEqual([{ status: "CONFIRMED", paymentStatus: "SUCCEEDED" }]);

  const { rows: ledgerRows } = await db.query<{ account: string; amountPaise: number }>(
    `SELECT account, "amountPaise" FROM "LedgerEntry" WHERE "bookingId" = $1 ORDER BY "amountPaise" DESC`,
    [bookingId],
  );
  expect(ledgerRows.length).toBe(3);
  expect(ledgerRows.map((r) => r.account)).toContain("RENTER_PAYMENT");
  expect(ledgerRows.map((r) => r.account)).toContain("HOST_EARNINGS");
  expect(ledgerRows.map((r) => r.account)).toContain("PLATFORM_COMMISSION");
});
