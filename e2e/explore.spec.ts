import { expect as baseExpect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import { PUNE_LOCALITIES } from "../src/components/explore/localities";

// No Mapbox token in e2e, so /explore runs list-only; data comes from prisma/seed.ts.
if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

// Results are fetched client-side; a dev server under load needs more than 5 s.
const expect = baseExpect.configure({ timeout: 15_000 });

const cards = (page: Page) =>
  page.getByRole("list", { name: "Parking spaces" }).locator(":scope > li");
/** Results load after hydration, so a visible card means the search form is live. */
const hydrated = (page: Page) => expect(cards(page).first()).toBeVisible();
const areaUrl = (name: string, extra = "") => {
  const l = PUNE_LOCALITIES.find((p) => p.name === name)!;
  return `/explore?q=${encodeURIComponent(name)}&lat=${l.lat}&lng=${l.lng}&radiusMeters=3000${extra}`;
};

test.describe("explore", () => {
  test("text search for a Pune locality lists its seeded spaces", async ({ page }) => {
    await page.goto("/explore");
    await expect(page.getByText("Map unavailable in this environment")).toBeVisible();
    await hydrated(page);
    await page.getByLabel("Area or landmark in Pune").fill("Koregaon Park");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/q=Koregaon\+Park/);
    await expect(cards(page).filter({ hasText: "near Koregaon Park" })).toHaveCount(5);
    await expect(
      page.getByRole("link", { name: "Directions to area (approximate)" }).first(),
    ).toHaveAttribute("href", /google\.com\/maps/);
  });

  test("the covered filter narrows results and lives in the URL", async ({ page }) => {
    await page.goto(areaUrl("Koregaon Park"));
    await expect(cards(page).first()).toBeVisible();
    const before = await cards(page).count();
    await page.getByRole("button", { name: /^Filters/ }).click();
    await page.getByLabel("Covered").check();
    await page.getByRole("button", { name: "Show results" }).click();
    await expect(page).toHaveURL(/covered=true/);
    await expect(page.getByRole("button", { name: /Filters.*1 active/ })).toBeVisible();
    await expect(cards(page).first()).toBeVisible();
    const after = await cards(page).count();
    expect(after).toBeLessThan(before);
    for (const card of await cards(page).all()) await expect(card).toContainText("Covered");
    await page.goBack();
    await expect(page).not.toHaveURL(/covered=true/);
  });

  test("a time window overlapping a confirmed booking excludes that listing", async ({ page }) => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const {
      rows: [b],
    } = await client
      .query(
        // Seed bookings only (other specs insert their own), on a 24x7 listing so the
        // week-later control is inside the schedule on any weekday.
        `SELECT b."startAt", b."endAt", l.title, l.locality FROM "Booking" b
         JOIN "Listing" l ON l.id = b."listingId"
         JOIN "User" u ON u.id = b."renterId"
         WHERE b.status = 'CONFIRMED' AND l.status = 'PUBLISHED' AND b."startAt" > now()
           AND u.email LIKE '%@parkshare.local'
           AND (SELECT count(*) FROM "AvailabilityRule" r WHERE r."listingId" = l.id
                AND r."startMinute" = 0 AND r."endMinute" = 1440) = 7
         ORDER BY b."startAt" LIMIT 1`,
      )
      .finally(() => client.end());
    expect(b, "a future seed booking (re-run `npm run db:seed`)").toBeTruthy();
    const window = (shiftDays: number) => {
      const shift = (d: Date) => new Date(d.getTime() + shiftDays * 86_400_000).toISOString();
      return `&rentalType=HOURLY&startAt=${shift(b.startAt)}&endAt=${shift(b.endAt)}`;
    };
    // Control: same weekday and hours a week later, when the space is free.
    await page.goto(areaUrl(b.locality, window(7)));
    await expect(cards(page).filter({ hasText: b.title })).toHaveCount(1);
    await page.goto(areaUrl(b.locality, window(0)));
    await expect(cards(page).first()).toBeVisible();
    await expect(cards(page).filter({ hasText: b.title })).toHaveCount(0);
  });

  test("denied location shows a clear state and text search still works", async ({ page }) => {
    await page.context().clearPermissions();
    await page.goto("/explore");
    await hydrated(page);
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByText("Location access is blocked")).toBeVisible();
    await page.getByLabel("Area or landmark in Pune").fill("Baner");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(cards(page).filter({ hasText: "near Baner" }).first()).toBeVisible();
  });

  test("empty and error states render, and retry recovers", async ({ page }) => {
    // Outside Pune: the server clamps to the city and finds nothing.
    await page.goto("/explore?q=Map+area&minLat=19&minLng=73.7&maxLat=19.1&maxLng=73.8");
    await expect(
      page.getByText("No spaces here for those times — try widening the area or changing times."),
    ).toBeVisible();

    await page.route("**/api/listings?**", (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal_error", message: "Search is down" } }),
      }),
    );
    await page.goto(areaUrl("Baner"));
    await expect(page.getByRole("alert").filter({ hasText: "Search is down" })).toBeVisible();
    await page.unroute("**/api/listings?**");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(cards(page).first()).toBeVisible();
  });

  test("Load more follows the cursor", async ({ page }) => {
    await page.goto("/explore?q=Map+area&minLat=18.4&minLng=73.7&maxLat=18.7&maxLng=74.05");
    await expect(cards(page)).toHaveCount(20);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(cards(page)).toHaveCount(40);
  });

  test("is accessible and doesn't scroll sideways at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(areaUrl("Shivajinagar"));
    await expect(cards(page).first()).toBeVisible();
    expect(
      await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")),
    ).toEqual([]);
    await page.getByRole("button", { name: /^Filters/ }).click();
    await expect(page.getByRole("dialog", { name: "Filters" })).toBeVisible();
    expect(
      await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
