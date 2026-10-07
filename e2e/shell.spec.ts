import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Signed out: protected tabs land on sign-in (the signed-in pages have their own specs).
const routes = [
  ["Explore", /\/explore$/],
  ["Bookings", /\/sign-in\?callbackUrl=%2Fbookings/],
  ["Host", /\/sign-in\?callbackUrl=%2Fhost/],
  ["Account", /\/sign-in\?callbackUrl=%2Faccount/],
] as const;

test.describe("app shell", () => {
  test("mobile navigation is accessible and does not overflow", async ({ page }) => {
    for (const [label, url] of routes) {
      await page.goto("/explore");
      await page.getByRole("link", { name: label }).last().click();
      await expect(page).toHaveURL(url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? "")).length,
      ).toBe(0);
    }
  });

  test("desktop displays the header navigation", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/explore");
    await expect(
      page.locator("header").getByRole("navigation", { name: "Primary navigation" }),
    ).toBeVisible();
  });
});
