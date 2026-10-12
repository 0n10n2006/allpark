import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers/session";

// helpers/session loads .env, so DATABASE_URL is set by now.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
test.afterAll(() => db.end());

// A cold `next dev` compiles each page and API route on first hit; allow for that.
test.describe.configure({ timeout: 120_000 });
const SLOW = { timeout: 30_000 };

const DAY = 24 * 60 * 60 * 1000;

/** A seeded PUBLISHED listing, open 24×7, that takes hatchbacks. */
async function seededListing() {
  const { rows } = await db.query<{ id: string; address: string; accessInstructions: string }>(
    `SELECT l.id, l.address, l."accessInstructions" FROM "Listing" l
     JOIN "User" u ON u.id = l."hostId"
     WHERE u.email LIKE 'host_@parkshare.local'
       AND l.status = 'PUBLISHED' AND l."hourlyPaise" IS NOT NULL
       AND 'HATCHBACK' = ANY(l."vehicleTypes")
       AND (SELECT count(*) FROM "AvailabilityRule" a
            WHERE a."listingId" = l.id AND a."startMinute" = 0 AND a."endMinute" = 1440) = 7
     ORDER BY l.title LIMIT 1`,
  );
  expect(rows[0], "seed has a 24x7 listing that takes hatchbacks").toBeTruthy();
  return rows[0];
}

/** A fresh signed-in renter with one hatchback. */
async function signInRenter(context: BrowserContext, baseURL: string) {
  const { userId } = await signIn(context, baseURL);
  await db.query(
    `INSERT INTO "Vehicle" ("userId", registration, type, "heightCm", "updatedAt")
     VALUES ($1, 'MH12ZZ0001', 'HATCHBACK', 150, now())`,
    [userId],
  );
}

/** IST wall-clock "YYYY-MM-DDTHH:mm" for an instant (IST = UTC+5:30, no DST). */
const istLocal = (t: number) => new Date(t + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 16);

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" | ")}`)).toEqual([]);
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

async function quote(page: Page, startLocal: string, endLocal: string) {
  // Defaults appear once the panel hydrates; filling earlier would race React.
  await expect(page.getByLabel("Start (IST)")).not.toHaveValue("");
  await page.getByLabel("Start (IST)").fill(startLocal);
  await page.getByLabel("End (IST)").fill(endLocal);
  await page.getByRole("button", { name: "Get price" }).click();
  await expect(page.getByRole("heading", { name: "Price breakdown" })).toBeVisible(SLOW);
}

test("signed out: approximate location only, sign in to book", async ({ page }) => {
  const listing = await seededListing();
  await page.goto(`/listings/${listing.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible(SLOW);
  await expect(page.getByRole("heading", { name: "Availability, next 7 days" })).toBeVisible();
  const cta = page.getByRole("link", { name: "Sign in to book" });
  await expect(cta).toHaveAttribute(
    "href",
    `/sign-in?callbackUrl=${encodeURIComponent(`/listings/${listing.id}`)}`,
  );
  const reportCta = page.getByRole("link", { name: "Sign in to report" });
  await expect(reportCta).toHaveAttribute(
    "href",
    `/sign-in?callbackUrl=${encodeURIComponent(`/listings/${listing.id}`)}`,
  );
  const html = await page.content();
  expect(html).not.toContain(listing.address);
  expect(html).not.toContain(listing.accessInstructions);
  await expectAccessible(page);
});

test("signed in: report dialog visible", async ({ context, baseURL, page }) => {
  await signInRenter(context, baseURL!);
  const listing = await seededListing();
  await page.goto(`/listings/${listing.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible(SLOW);
  const reportBtn = page.getByRole("button", { name: "Report this listing" });
  await expect(reportBtn).toBeVisible();
  await reportBtn.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Report this listing" })).toBeVisible();
  await expect(dialog.getByLabel("What is the problem?")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("suspended listing is a 404 state", async ({ page }) => {
  const { rows } = await db.query(`SELECT id FROM "Listing" WHERE status = 'SUSPENDED' LIMIT 1`);
  await page.goto(`/listings/${rows[0].id}`);
  await expect(page.getByText("This space isn't available")).toBeVisible();
});

test("quote, agree, reserve, checkout; a second renter sees 'just taken'", async ({
  browser,
  baseURL,
}, testInfo) => {
  const listing = await seededListing();
  // A far-future slot unique per run and per project, so parallel projects and reruns
  // (holds live 10 minutes) never collide with each other or the seeded bookings.
  const day = Math.floor(Date.now() / DAY) * DAY + (20 + Math.floor(Math.random() * 300)) * DAY;
  const startUtc = day + (testInfo.project.name === "mobile" ? 4 : 8) * 60 * 60 * 1000;
  const start = istLocal(startUtc);
  const end = istLocal(startUtc + 2 * 60 * 60 * 1000);

  const first = await browser.newContext();
  await signInRenter(first, baseURL!);
  const page = await first.newPage();
  await page.goto(`/listings/${listing.id}`);
  await quote(page, start, end);

  // FR-05 / FR-08: every charge, the end time, grace/overstay, cancellation, and the dispute path.
  await expect(page.getByText("2 hours ×")).toBeVisible();
  await expect(page.getByText("Total to pay")).toBeVisible();
  await expect(page.getByText(/commission/i)).toHaveCount(0);
  await expect(page.getByText("Grace period and overstay")).toBeVisible();
  await expect(page.getByText("Cancellation", { exact: true })).toBeVisible();
  await expect(page.getByText("Problems and disputes")).toBeVisible();
  await expect(page.getByRole("timer")).toContainText(/Price held for \d+:\d\d/);

  const reserve = page.getByRole("button", { name: /^Reserve for/ });
  await expect(reserve).toBeDisabled();
  await page.getByLabel("I agree to these terms", { exact: false }).check();
  await expectAccessible(page);
  await reserve.click();

  await expect(page).toHaveURL(/\/checkout\/[0-9a-f-]{36}$/, SLOW);
  await expect(page.getByRole("timer")).toHaveText(/^\d+:\d\d$/, SLOW);
  // The Pay flow itself is covered by checkout-pay.spec.ts (T4.1).
  await expect(page.getByRole("button", { name: /^Pay/ })).toBeVisible();
  await expect(
    page.getByRole("term").filter({ hasText: "Grace period and overstay" }),
  ).toBeVisible();
  await expectAccessible(page);

  const second = await browser.newContext();
  await signInRenter(second, baseURL!);
  const other = await second.newPage();
  await other.goto(`/listings/${listing.id}`);
  await quote(other, start, end);
  await other.getByLabel("I agree to these terms", { exact: false }).check();
  await other.getByRole("button", { name: /^Reserve for/ }).click();
  await expect(other.getByText("Just taken")).toBeVisible(SLOW);
  // Inputs survive so the renter can just pick another time.
  await expect(other.getByLabel("Start (IST)")).toHaveValue(start);

  // Hold runs out → "expired, start again" → a fresh, usable booking panel.
  const bookingId = page.url().split("/").pop();
  await db.query(
    `UPDATE "Booking" SET "holdExpiresAt" = now() - interval '1 second' WHERE id = $1`,
    [bookingId],
  );
  await page.reload();
  await expect(page.getByText("Your hold has expired")).toBeVisible(SLOW);
  await page.getByRole("link", { name: "Start again" }).click();
  await expect(page.getByRole("button", { name: "Get price" })).toBeEnabled(SLOW);
  await expect(page.getByRole("button", { name: /^Reserve for/ })).toHaveCount(0);

  await first.close();
  await second.close();
});
