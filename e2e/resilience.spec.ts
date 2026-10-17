import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers/session";

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {}
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

let publishedListingId: string;

test.beforeAll(async () => {
  await db.connect();
  const run = randomUUID().slice(0, 8);

  const hostRes = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, name, roles, "hostVerificationStatus", "updatedAt")
     VALUES ($1, 'Resilience Host', '{HOST}', 'VERIFIED', now()) RETURNING id`,
    [`res-host-${run}@test.local`],
  );
  const hostId = hostRes.rows[0].id;

  const listingRes = await db.query<{ id: string }>(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
       "accessInstructions", status, "hostAttestedAt", "updatedAt")
     VALUES ($1, $2, 'Resilience testing space', '88 JM Road', 'Shivajinagar', 18.53, 73.84,
       18.531, 73.841, 'COVERED', '{SEDAN,SUV}', 6000, 'Gate PIN 5678', 'PUBLISHED', now(), now()) RETURNING id`,
    [hostId, `Resilience Space ${run}`],
  );
  publishedListingId = listingRes.rows[0].id;

  // Add 24x7 availability rules for all weekdays
  for (let d = 0; d < 7; d++) {
    await db.query(
      `INSERT INTO "AvailabilityRule" ("listingId", weekday, "startMinute", "endMinute", "updatedAt")
       VALUES ($1, $2, 0, 1440, now())`,
      [publishedListingId, d],
    );
  }

  // Add a photo
  await db.query(
    `INSERT INTO "ListingPhoto" ("listingId", url, position, "moderationStatus", "updatedAt")
     VALUES ($1, 'https://res.cloudinary.com/demo/image/upload/sample.jpg', 0, 'APPROVED', now())`,
    [publishedListingId],
  );
});

test.afterAll(async () => {
  await db.end();
});

test.describe("Resilience: slow network, refresh recovery, and offline retry", () => {
  test("slow network shows loading states and prevents double submit", async ({
    page,
    context,
  }) => {
    const { userId } = await signIn(context, { roles: ["RENTER"] });

    // Add vehicle for this authenticated session
    await db.query(
      `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
       VALUES ($1, $2, 'SEDAN', 'City Sedan', now())`,
      [userId, `MH12RS${randomUUID().slice(0, 4).toUpperCase()}`],
    );

    let holdCalls = 0;
    // 3 s route delay on /api/quotes
    await page.route("**/api/quotes", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });

    // 3 s route delay on /api/bookings/hold
    await page.route("**/api/bookings/hold", async (route) => {
      holdCalls++;
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });

    await page.goto(`/listings/${publishedListingId}`);
    await expect(page.getByRole("heading", { name: "Book this space" })).toBeVisible();

    // Click "Get price"
    const getPriceBtn = page.getByRole("button", { name: "Get price" });
    await expect(getPriceBtn).toBeVisible();
    await getPriceBtn.click();

    // Assert loading state on button and live region, button disabled
    const gettingPriceBtn = page.getByRole("button", { name: /Getting price/i });
    await expect(gettingPriceBtn).toBeVisible();
    await expect(gettingPriceBtn).toBeDisabled();
    await expect(page.getByText(/Calculating your price/i)).toBeVisible();

    // Wait for quote to arrive and render breakdown
    await expect(page.getByRole("heading", { name: "Price breakdown" })).toBeVisible({ timeout: 15_000 });

    // Accept terms
    await page.getByRole("checkbox", { name: /I agree to these terms/i }).check();

    // Find Reserve button
    const reserveBtn = page.getByRole("button", { name: /^Reserve for/i });
    await expect(reserveBtn).toBeEnabled();

    // Click reserve button
    await reserveBtn.click();

    // Assert loading state while holding
    const reservingBtn = page.getByRole("button", { name: /Reserving/i });
    await expect(reservingBtn).toBeVisible();
    await expect(reservingBtn).toBeDisabled();

    // Attempt double click on the button while it is holding/disabled
    await reservingBtn.click({ force: true }).catch(() => {});

    // Lands on /checkout/[bookingId]
    await expect(page).toHaveURL(/\/checkout\/[0-9a-f-]+/, { timeout: 15_000 });

    // Assert EXACTLY ONE hold request was issued
    expect(holdCalls).toBe(1);

    // Flow 2: Refreshing /checkout/[bookingId] mid-hold restores countdown and summary
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
    const initialSummary = await page.getByRole("heading", { name: "Summary" }).isVisible();
    expect(initialSummary).toBe(true);

    // Refresh page
    await page.reload();

    // Restores countdown and summary
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
  });

  test("going offline during 'Get price' shows error with retry, and retry succeeds", async ({
    page,
    context,
  }) => {
    const { userId } = await signIn(context, { roles: ["RENTER"] });

    await db.query(
      `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
       VALUES ($1, $2, 'SEDAN', 'City Sedan', now())`,
      [userId, `MH12RS${randomUUID().slice(0, 4).toUpperCase()}`],
    );

    await page.goto(`/listings/${publishedListingId}`);
    await expect(page.getByRole("heading", { name: "Book this space" })).toBeVisible();

    // Abort network request to simulate offline during "Get price"
    await page.route("**/api/quotes", (route) => route.abort("failed"));

    // Click "Get price"
    await page.getByRole("button", { name: "Get price" }).click();

    // Assert error is announced with alert
    const alert = page.getByRole("alert").filter({ hasText: /Check your connection and try again/i });
    await expect(alert).toBeVisible();

    // Restore network (come back online)
    await page.unroute("**/api/quotes");

    // Retry "Get price"
    await page.getByRole("button", { name: "Get price" }).click();

    // Assert retry succeeds and price breakdown is shown
    await expect(page.getByRole("heading", { name: "Price breakdown" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Reserve for/i })).toBeVisible();
  });
});
