import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = [
  ["Explore", "/explore", "Explore parking"],
  ["Bookings", "/bookings", "Your bookings"],
  ["Host", "/host", "Host your space"],
  ["Account", "/account", "Your account"],
] as const;

test.describe("app shell", () => {
  test("mobile navigation is accessible and does not overflow", async ({ page }) => {
    for (const [label, route, heading] of routes) {
      await page.goto("/explore");
      await page.getByRole("link", { name: label }).last().click();
      await expect(page).toHaveURL(route);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
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
