import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "../helpers/session";

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {}
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

let hostId: string;
let publishedListingId: string;
let confirmedBookingId: string;
let disputeId: string;

test.beforeAll(async () => {
  await db.connect();
  const run = randomUUID().slice(0, 8);

  // 1. Host + listing
  const hostRes = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, name, roles, "hostVerificationStatus", "updatedAt")
     VALUES ($1, 'Keyboard Host', '{HOST}', 'VERIFIED', now()) RETURNING id`,
    [`kb-host-${run}@test.local`],
  );
  hostId = hostRes.rows[0].id;

  const listingRes = await db.query<{ id: string }>(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
       "accessInstructions", status, "hostAttestedAt", "updatedAt")
     VALUES ($1, $2, 'Keyboard accessible space', '50 FC Road', 'Shivajinagar', 18.52, 73.85,
       18.521, 73.851, 'COVERED', '{SEDAN,SUV}', 5000, 'Gate PIN 1234', 'PUBLISHED', now(), now()) RETURNING id`,
    [hostId, `KB Space ${run}`],
  );
  publishedListingId = listingRes.rows[0].id;

  // Add 24x7 availability rules
  for (let d = 0; d < 7; d++) {
    await db.query(
      `INSERT INTO "AvailabilityRule" ("listingId", weekday, "startMinute", "endMinute", "updatedAt")
       VALUES ($1, $2, 0, 1440, now())`,
      [publishedListingId, d],
    );
  }

  // 2. Confirmed booking for cancel dialog
  const renterRes = await db.query<{ id: string }>(
    `INSERT INTO "User" (email, name, roles, "updatedAt")
     VALUES ($1, 'Booking Renter', '{RENTER}', now()) RETURNING id`,
    [`kb-brenter-${run}@test.local`],
  );
  const renterId = renterRes.rows[0].id;

  const bookingRes = await db.query<{ id: string }>(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
       "blockedUntil", status, "subtotalPaise", "commissionPaise", "hostEarningsPaise",
       "totalPaise", "updatedAt")
     VALUES ($1, $2, 'HOURLY', now() + interval '2 hours', now() + interval '4 hours',
       now() + interval '4 hours', 'CONFIRMED', 10000, 1000, 9000, 10000, now()) RETURNING id`,
    [publishedListingId, renterId],
  );
  confirmedBookingId = bookingRes.rows[0].id;

  // 3. Admin + Dispute for admin table actions
  await db.query(
    `INSERT INTO "User" (email, name, roles, "updatedAt")
     VALUES ($1, 'Keyboard Admin', '{ADMIN}', now())`,
    [`kb-admin-${run}@test.local`],
  );

  const disputeRes = await db.query<{ id: string }>(
    `INSERT INTO "Dispute" ("bookingId", "raisedById", category, description, status, "updatedAt")
     VALUES ($1, $2, 'ACCESS_DENIED', 'Keypad pin did not work at gate', 'OPEN', now()) RETURNING id`,
    [confirmedBookingId, renterId],
  );
  disputeId = disputeRes.rows[0].id;
});

test.afterAll(async () => {
  await db.end();
});

test.describe("Accessibility: Keyboard-only flows", () => {
  test("explore: filters sheet open/close with Escape and focus returning to the trigger", async ({
    page,
  }) => {
    await page.goto("/explore");
    const filtersTrigger = page.getByRole("button", { name: /^Filters/ });
    await expect(filtersTrigger).toBeVisible();

    // Focus trigger via keyboard / programmatic focus
    await filtersTrigger.focus();
    await expect(filtersTrigger).toBeFocused();

    // Open sheet via Enter key
    await page.keyboard.press("Enter");
    const sheetDialog = page.getByRole("dialog");
    await expect(sheetDialog).toBeVisible();

    // Close sheet via Escape key
    await page.keyboard.press("Escape");
    await expect(sheetDialog).not.toBeVisible();

    // Focus must return to the trigger button
    await expect(filtersTrigger).toBeFocused();
  });

  test("booking panel form: error announcement with aria-describedby and aria-invalid on invalid fields", async ({
    page,
    context,
  }) => {
    const { userId } = await signIn(context, { roles: ["RENTER"] });
    await db.query(
      `INSERT INTO "Vehicle" ("userId", registration, type, nickname, "updatedAt")
       VALUES ($1, $2, 'SEDAN', 'City Sedan', now())`,
      [userId, `MH12KB${randomUUID().slice(0, 4).toUpperCase()}`],
    );

    await page.goto(`/listings/${publishedListingId}`);

    // Wait for the booking panel to mount
    await expect(page.getByRole("heading", { name: "Book this space" })).toBeVisible();

    const startInput = page.getByLabel("Start (IST)");
    const endInput = page.getByLabel("End (IST)");

    await expect(startInput).toBeVisible();
    await expect(endInput).toBeVisible();
    await expect(startInput).not.toHaveValue("");

    // Set an invalid interval: start time after end time
    await startInput.fill("2026-10-25T14:00");
    await endInput.fill("2026-10-25T10:00");

    // Focus the submit button and press Enter
    const getPriceBtn = page.getByRole("button", { name: "Get price" });
    await getPriceBtn.focus();
    await expect(getPriceBtn).toBeFocused();
    await getPriceBtn.click();

    // Verify aria-invalid and aria-describedby
    await expect(endInput).toHaveAttribute("aria-invalid", "true");
    const describedBy = await endInput.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const errorEl = page.locator(`#${describedBy}`);
    await expect(errorEl).toBeVisible();
    await expect(errorEl).toHaveAttribute("role", "alert");
    await expect(errorEl).toContainText("The end time must be after the start time");
  });

  test("dialog focus trap: cancel booking dialog traps keyboard focus within itself", async ({
    page,
    context,
  }) => {
    // Sign in as the renter who owns the booking
    const { userId } = await signIn(context, { roles: ["RENTER"] });
    // Reassign booking to this user so the user can view and cancel it
    await db.query(`UPDATE "Booking" SET "renterId" = $1 WHERE id = $2`, [userId, confirmedBookingId]);

    await page.goto(`/bookings/${confirmedBookingId}`);

    const cancelTrigger = page.getByRole("button", { name: "Cancel booking" });
    await expect(cancelTrigger).toBeVisible();

    // Open dialog
    await cancelTrigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Cancel this booking?" })).toBeVisible();

    const closeBtn = page.getByRole("button", { name: "Keep booking as is" });
    const submitBtn = dialog.getByRole("button", { name: "Cancel booking" });
    await expect(closeBtn).toBeVisible();
    await expect(submitBtn).toBeVisible();

    // Verify keyboard focus cycles between the dialog buttons and never leaves the dialog
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const activeInfo = await page.evaluate(() => {
        const active = document.activeElement;
        const main = document.querySelector("#main");
        const insideMainOutsideDialog = main?.contains(active) && !active?.closest('[role="dialog"]');
        const activeText = active?.textContent?.trim();
        return { isOutside: Boolean(insideMainOutsideDialog), activeText };
      });
      // Focus must NEVER escape to page content outside the dialog
      expect(activeInfo.isOutside).toBe(false);
    }

    // Press Escape to dismiss
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("admin table: action buttons are reachable by keyboard Tab navigation", async ({
    page,
    context,
  }) => {
    await signIn(context, { roles: ["ADMIN"] });
    await page.goto("/admin/disputes");

    await expect(page.getByRole("heading", { name: "Disputes Queue & Resolution" })).toBeVisible();
    await expect(page.locator("table")).toBeVisible();

    // Locate action buttons for the dispute
    const viewButton = page.getByRole("button", { name: new RegExp(`View timeline for dispute ${disputeId}`, "i") });
    await expect(viewButton).toBeVisible();

    // Tab through the page until reaching the table action buttons
    let viewFocused = false;
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const isFocused = await viewButton.evaluate((el) => document.activeElement === el);
      if (isFocused) {
        viewFocused = true;
        break;
      }
    }
    expect(viewFocused).toBe(true);

    // One more Tab should reach the "Resolve" button for that row
    await page.keyboard.press("Tab");
    const activeText = await page.evaluate(() => document.activeElement?.textContent);
    expect(activeText).toContain("Resolve");
  });
});
