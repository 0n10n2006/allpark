import { expect, test } from "@playwright/test";

test("home page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/ParkShare/);
  await expect(page).toHaveURL(/\/explore$/);
});
