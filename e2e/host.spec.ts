import { expect as baseExpect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import { signIn } from "./helpers/session";

// The dev server reads .env; so do we, to seed users into the same database.
try {
  process.loadEnvFile(".env");
} catch {}

// The dev server compiles each API route on first hit, which can take several seconds.
const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

// AUTH_URL is localhost; mutations from any other origin are rejected as cross-site.

async function sql(text: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}

const verify = (userId: string) =>
  sql(`UPDATE "User" SET "hostVerificationStatus" = 'VERIFIED' WHERE id = $1`, [userId]);

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const png = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

/** Stands in for Cloudinary; records each upload's form fields. */
async function mockCloudinary(page: Page) {
  const uploads: string[] = [];
  await page.route("https://api.cloudinary.com/**", async (route) => {
    uploads.push(route.request().postDataBuffer()?.toString("latin1") ?? "");
    await route.fulfill({ json: { public_id: "ignored" } });
  });
  await page.route("https://res.cloudinary.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PNG }),
  );
  return uploads;
}

const DRAFT = {
  title: "E2E covered spot",
  description: "A covered car spot near the main road.",
  address: "12 Test Lane, Kothrud, Pune 411038",
  locality: "Kothrud",
  lat: 18.5074,
  lng: 73.8077,
  spaceType: "COVERED",
  vehicleTypes: ["SEDAN"],
};

async function createDraft(page: Page) {
  const res = await page.request.post("/api/listings", { data: DRAFT });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

// Enter rather than click: keyboard path, and in dev the Next.js tools button can cover it.
const stepHeading = (page: Page, n: number, label: string) =>
  expect(page.getByRole("heading", { name: `Step ${n} of 8: ${label}` })).toBeVisible();

test("a renter becomes a host and sees the pending status", async ({ page, context }) => {
  await signIn(context, ["RENTER"]);
  await page.goto("/host");
  await expect(page.getByRole("heading", { name: "Become a host" })).toBeVisible();
  await expectAccessible(page);

  const submit = page.getByRole("button", { name: "Become a host" });
  await expect(submit).toBeDisabled();
  await page.getByLabel("I'm authorized to rent out the spaces I list").check();
  await submit.click();

  await expect(page.getByRole("heading", { name: "Verification pending" })).toBeVisible();
  await expect(page.getByText("you'll be able to publish once you're verified")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No listings yet" })).toBeVisible();
  await expectAccessible(page);
});

test("a host drafts a listing through every step and publishes once verified", async ({
  page,
  context,
}) => {
  const { userId } = await signIn(context, ["RENTER", "HOST"], "PENDING");
  const uploads = await mockCloudinary(page);
  await page.goto("/host/listings/new");

  await stepHeading(page, 1, "Basics");
  await expect(page.getByRole("link", { name: "1. Basics" })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue" }).press("Enter");
  await expect(page.getByText("Enter a title of 3 to 120 characters.")).toBeVisible();
  await expect(page.getByLabel("Title")).toBeFocused();
  await page.getByLabel("Title").fill(DRAFT.title);
  await page.getByLabel("Description", { exact: true }).fill(DRAFT.description);
  await page.getByLabel("Space type").selectOption("COVERED");
  await page.getByRole("button", { name: "Continue" }).press("Enter");

  await stepHeading(page, 2, "Location");
  await expect(
    page.getByText("The exact address is only shown to confirmed renters"),
  ).toBeVisible();
  await page.getByLabel("Full address").fill(DRAFT.address);
  await page.getByLabel("Locality").fill(DRAFT.locality);
  await page.getByLabel("Latitude").fill(String(DRAFT.lat));
  await page.getByLabel("Longitude").fill(String(DRAFT.lng));
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue" }).press("Enter");

  await stepHeading(page, 3, "Vehicles & size");
  await page.getByLabel("Sedan").check();
  await page.getByLabel("Max height").fill("210");
  await page.getByLabel("Covered", { exact: true }).check();
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  await stepHeading(page, 4, "Pricing");
  await expect(page).toHaveURL(/\/host\/listings\/[0-9a-f-]{36}\/edit\?step=pricing$/);
  await page.getByLabel("Per hour (₹)").fill("40");
  await page.getByLabel("Per day (₹)").fill("250.50");
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  await stepHeading(page, 5, "Availability");
  await page.getByRole("button", { name: "Add time range for Monday" }).click();
  await expectAccessible(page);
  await page.getByRole("checkbox", { name: "Open 24 hours, 7 days a week" }).check();
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  await stepHeading(page, 6, "Photos");
  await page.getByLabel("Upload photos").setInputFiles([png("front.png")]);
  await expect(page.getByAltText("Photo 1")).toBeVisible();
  await expect(page.getByText("Cover", { exact: true })).toBeVisible();
  expect(uploads).toHaveLength(1);
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  await stepHeading(page, 7, "Access & rules");
  await page.getByLabel("Access instructions").fill("Gate code 4321, spot B2.");
  await page.getByLabel("Rules for renters").fill("No car washing.");
  await page.getByLabel(/I'm authorized to rent out this space/).check();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Save and continue" }).press("Enter");

  await stepHeading(page, 8, "Review & publish");
  await expect(page.getByText("₹40 hourly · ₹250.50 daily")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Publish listing" }).click();
  await expect(page.getByRole("heading", { name: "Host verification required" })).toBeVisible();

  await verify(userId);
  await page.getByRole("button", { name: "Publish listing" }).click();
  await expect(page.getByRole("heading", { name: "Your listing is published" })).toBeVisible();

  await page.getByRole("link", { name: "Back to my listings" }).click();
  const card = page.getByRole("listitem").filter({ hasText: DRAFT.title });
  await expect(card.getByText("Published")).toBeVisible();
  await expect(card.getByText("From ₹40 / hour")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verified host" })).toBeVisible();

  // The saved schedule round-trips into the editor. cacheComponents keeps the step-5 page we
  // filled in earlier mounted but hidden (<Activity>), so only a role query (visible, in the
  // a11y tree) is sure to read the fresh editor rather than that stale copy.
  await card.getByRole("link", { name: /Edit/ }).click();
  await page.getByRole("link", { name: "5. Availability" }).click();
  await expect(page.getByRole("checkbox", { name: "Open 24 hours, 7 days a week" })).toBeChecked();
});

test("photos upload with exactly the signed params, reorder, and delete", async ({
  page,
  context,
}) => {
  await signIn(context, ["HOST"], "PENDING");
  const uploads = await mockCloudinary(page);
  const id = await createDraft(page);
  await page.goto(`/host/listings/${id}/edit?step=photos`);
  await stepHeading(page, 6, "Photos");

  await page.getByLabel("Upload photos").setInputFiles([png("a.png"), png("b.png")]);
  await expect(page.getByAltText("Photo 2")).toBeVisible();
  expect(uploads).toHaveLength(2);
  for (const body of uploads) {
    for (const field of [
      "file",
      "api_key",
      "timestamp",
      "signature",
      "public_id",
      "allowed_formats",
    ])
      expect(body).toContain(`name="${field}"`);
    expect(body).not.toContain('name="folder"');
  }
  await expectAccessible(page);

  const srcs = () =>
    page
      .getByRole("list", { name: "Listing photos" })
      .locator("img")
      .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  const before = await srcs();
  await page.getByRole("button", { name: "Move photo 2 up" }).press("Enter");
  await expect(page.getByText("Photo moved to position 1, now the cover photo.")).toBeAttached();
  expect(await srcs()).toEqual([before[1], before[0]]);
  await expect(page.getByRole("button", { name: "Move photo 1 down" })).toBeFocused();

  await page.getByRole("button", { name: "Delete photo 1" }).click();
  await expect(page.getByAltText("Photo 2")).toHaveCount(0);
  expect(await srcs()).toEqual([before[0]]);
});

test("missing upload keys and publish errors are explained with links to the step", async ({
  page,
  context,
}) => {
  const { userId } = await signIn(context, ["HOST"], "PENDING");
  await page.route("**/photos/sign", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "uploads_not_configured", message: "Photo uploads are not configured" },
      },
    }),
  );
  const id = await createDraft(page);
  await verify(userId);

  await page.goto(`/host/listings/${id}/edit?step=photos`);
  await page.getByLabel("Upload photos").setInputFiles([png("a.png")]);
  await expect(page.getByText("Photo uploads aren't configured in this environment")).toBeVisible();

  await page.getByRole("link", { name: "7. Access & rules" }).click();
  await page.getByLabel(/I'm authorized to rent out this space/).check();
  await page.getByRole("link", { name: "8. Review & publish" }).click();
  await page.getByRole("button", { name: "Publish listing" }).click();

  const errors = page.getByRole("alert").filter({ hasText: "Fix these before publishing" });
  await expect(errors.getByText("Add at least one photo")).toBeVisible();
  await expect(errors.getByText("Add at least one availability rule")).toBeVisible();
  await expectAccessible(page);
  await errors.getByRole("link", { name: "go to Pricing" }).click();
  await stepHeading(page, 4, "Pricing");
  await expect(page.getByText("Offer at least one rental type with a price")).toBeVisible();
});
