import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn } from "./helpers/session";

// Mutations must come from AUTH_URL's origin (src/server/http/route.ts assertSameOrigin).
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3000}`; // same as playwright.config
test.use({ baseURL: BASE });

async function openAccount(page: Page) {
  await signIn(page.context(), BASE);
  await page.goto("/account");
  await expect(page.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible({
    timeout: 15_000,
  });
}

async function addVehicle(page: Page, registration: string, type: string) {
  await page.getByRole("button", { name: "Add vehicle" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Registration number").fill(registration);
  await dialog.getByLabel("Vehicle type").selectOption(type);
  await dialog.getByRole("button", { name: "Add vehicle" }).click();
}

test("signed out /account redirects to sign-in", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Faccount/);
});

test("add two vehicles, edit one, delete one", async ({ page }) => {
  await openAccount(page);
  const vehicles = page.getByRole("region", { name: "Vehicles" });
  await expect(vehicles.getByText("No vehicles yet")).toBeVisible();

  await addVehicle(page, "mh12ab1234", "SEDAN"); // lowercase: uppercased on input
  await expect(vehicles.getByText("MH12AB1234")).toBeVisible();
  await addVehicle(page, "KA01MN4321", "SUV");
  await expect(vehicles.getByText("KA01MN4321")).toBeVisible();

  await vehicles.getByRole("button", { name: "Edit KA01MN4321" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nickname (optional)").fill("Family car");
  await dialog.getByLabel("Height (cm)").fill("180");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  // The first PATCH compiles the [id] route in dev, so allow longer than the default.
  await expect(vehicles.getByText(/Family car · SUV · 180/)).toBeVisible({ timeout: 15_000 });

  await vehicles.getByRole("button", { name: "Delete MH12AB1234" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete vehicle" }).click();
  await expect(vehicles.getByText("MH12AB1234")).toHaveCount(0);

  await page.reload();
  await expect(vehicles.getByText("KA01MN4321")).toBeVisible();
  await expect(vehicles.getByText("MH12AB1234")).toHaveCount(0);
});

test("a bad registration shows the server's error inline", async ({ page }) => {
  await openAccount(page);
  await addVehicle(page, "1234567", "HATCHBACK");
  const input = page.getByRole("dialog").getByLabel("Registration number");
  await expect(page.locator("#vehicle-registration-error")).toContainText(
    "Not a valid Indian registration number",
  );
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAttribute("aria-describedby", /vehicle-registration-error/);
  await expect(input).toBeFocused();
});

test("a preference toggle persists after reload", async ({ page }) => {
  await openAccount(page);
  const marketing = page.getByRole("switch", { name: "Offers and product news" });
  await expect(marketing).not.toBeChecked();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/me/preferences") && r.request().method() === "PATCH",
  );
  // Click the row text, not the switch: the whole row is the 44px touch target.
  await page.getByText("Offers and product news").click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("switch", { name: "Offers and product news" })).toBeChecked();
});

test("account page is accessible and fits 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAccount(page);
  await addVehicle(page, "DL3CAB1", "TWO_WHEELER");
  await expect(page.getByText("DL3CAB1")).toBeVisible();
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  expect(bad.map((v) => v.id)).toEqual([]);
});
