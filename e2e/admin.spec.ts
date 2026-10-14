import { randomUUID } from "node:crypto";
import { expect as baseExpect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import { signIn } from "./helpers/session";

try {
  process.loadEnvFile(".env");
} catch {}

const expect = baseExpect.configure({ timeout: 15_000 });
test.describe.configure({ timeout: 90_000 });

async function sql(text: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  if (bad.length > 0) {
    console.log("BAD AXE VIOLATIONS:", JSON.stringify(bad, null, 2));
  }
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test.describe("Admin Console UI (FR-13)", () => {
  test("non-admin visiting /admin gets redirected", async ({ page, context }) => {
    // 1. Unauthenticated visiting /admin gets redirected to sign-in
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/sign-in/);

    // 2. Authenticated non-admin (RENTER) visiting /admin gets redirected to home
    await signIn(context, { roles: ["RENTER"] });
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/(explore)?$/);
  });

  test("admin sees the dashboard with open items and passes accessibility", async ({
    page,
    context,
  }) => {
    await signIn(context, { roles: ["ADMIN"] });
    await page.goto("/admin");

    await expect(page.getByRole("heading", { name: "ParkShare Admin", level: 1 })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Operations Dashboard", level: 2 }),
    ).toBeVisible();
    await expect(page.getByText("Open Disputes")).toBeVisible();
    await expect(page.getByText("Pending Verifications")).toBeVisible();

    // Verify 0 serious/critical axe accessibility violations on dashboard
    await expectAccessible(page);
  });

  test("verify a host with reason creates an AuditLog row", async ({ page, context }) => {
    const run = randomUUID().slice(0, 8);
    const hostEmail = `pending-host-${run}@test.local`;
    const hostName = `Pending Host ${run}`;

    const {
      rows: [host],
    } = await sql(
      `INSERT INTO "User" (email, name, roles, "hostVerificationStatus", "updatedAt")
       VALUES ($1, $2, '{HOST}', 'PENDING', now()) RETURNING id`,
      [hostEmail, hostName],
    );

    await signIn(context, { roles: ["ADMIN"] });
    await page.goto(`/admin/users?q=${encodeURIComponent(hostEmail)}`);

    // Verify user row is visible
    const userRow = page.locator("tr").filter({ hasText: hostName });
    await expect(userRow).toBeVisible();

    // Click verify host button
    await userRow.getByRole("button", { name: `Verify host ${hostName}` }).click();

    // Fill audit reason in action dialog
    const reasonInput = page.getByPlaceholder(
      /Verified Aadhaar \/ PAN identity document against submitted host profile/i,
    );
    await expect(reasonInput).toBeVisible();
    await reasonInput.fill("Verified Aadhaar and electricity bill matching registered host details");

    // Submit verification
    await page.getByRole("button", { name: "Approve Verification" }).click();

    // Await toast notification
    await expect(page.getByText(/Host verified successfully/i)).toBeVisible();

    // Verify AuditLog in PostgreSQL database (action is host.verification)
    const { rows: logs } = await sql(
      `SELECT * FROM "AuditLog" WHERE "targetType" = 'User' AND "targetId" = $1 AND action = 'host.verification'`,
      [host.id],
    );
    expect(logs.length).toBe(1);
    expect(logs[0].reason).toContain("Verified Aadhaar and electricity bill");

    // Verify User record updated to VERIFIED
    const {
      rows: [updatedUser],
    } = await sql(`SELECT "hostVerificationStatus" FROM "User" WHERE id = $1`, [host.id]);
    expect(updatedUser.hostVerificationStatus).toBe("VERIFIED");
  });

  test("resolve a seeded dispute", async ({ page, context }) => {
    const run = randomUUID().slice(0, 8);

    const {
      rows: [host],
    } = await sql(
      `INSERT INTO "User" (email, name, roles, "hostVerificationStatus", "updatedAt")
       VALUES ($1, $2, '{HOST}', 'VERIFIED', now()) RETURNING id`,
      [`disp-host-${run}@test.local`, `Dispute Host ${run}`],
    );

    const listingTitle = `Dispute Bay ${run}`;
    const {
      rows: [listing],
    } = await sql(
      `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
         "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
         "accessInstructions", status, "updatedAt")
       VALUES ($1, $2, 'Covered bay', '15 Church Street', 'MG Road', 12.97, 77.60,
         12.971, 77.601, 'COVERED', '{SEDAN}', 6000, 'Gate PIN 1234', 'PUBLISHED', now()) RETURNING id`,
      [host.id, listingTitle],
    );

    const {
      rows: [renter],
    } = await sql(
      `INSERT INTO "User" (email, name, roles, "updatedAt")
       VALUES ($1, $2, '{RENTER}', now()) RETURNING id`,
      [`disp-renter-${run}@test.local`, `Dispute Renter ${run}`],
    );

    const {
      rows: [booking],
    } = await sql(
      `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
         "blockedUntil", status, "subtotalPaise", "commissionPaise", "hostEarningsPaise",
         "totalPaise", "updatedAt")
       VALUES ($1, $2, 'HOURLY', now() - interval '2 days', now() - interval '1 day',
         now() - interval '1 day', 'COMPLETED', 100000, 10000, 90000, 100000, now()) RETURNING id`,
      [listing.id, renter.id],
    );

    const {
      rows: [dispute],
    } = await sql(
      `INSERT INTO "Dispute" ("bookingId", "raisedById", category, description, status, "updatedAt")
       VALUES ($1, $2, 'ACCESS_DENIED', 'Gate was permanently locked by building management', 'OPEN', now()) RETURNING id`,
      [booking.id, renter.id],
    );

    await signIn(context, { roles: ["ADMIN"] });
    await page.goto("/admin/disputes");

    const disputeRow = page.locator("tr").filter({ hasText: listingTitle });
    await expect(disputeRow).toBeVisible();

    // Click Resolve
    await disputeRow.getByRole("button", { name: "Resolve" }).click();

    // Fill resolution text
    const resolutionTextarea = page.locator("#dispute-resolution");
    await expect(resolutionTextarea).toBeVisible();
    await resolutionTextarea.fill(
      "Full refund granted due to verified security gate failure during reservation period",
    );

    // Fill audit reason
    const reasonInput = page.getByPlaceholder(
      /Document the investigation findings and rationale for this resolution/i,
    );
    await reasonInput.fill(
      "Host acknowledged building gate malfunction and agreed to full renter concession",
    );

    // Submit resolution
    await page.getByRole("button", { name: "Submit Resolution" }).click();

    // Await toast
    await expect(page.getByText(/Dispute updated to RESOLVED/i)).toBeVisible();

    // Verify DB updated
    const {
      rows: [updatedDispute],
    } = await sql(`SELECT status, resolution FROM "Dispute" WHERE id = $1`, [dispute.id]);
    expect(updatedDispute.status).toBe("RESOLVED");
    expect(updatedDispute.resolution).toContain("Full refund granted");
  });

  test("create and mark-paid a payout for a seeded COMPLETED booking", async ({
    page,
    context,
  }) => {
    const run = randomUUID().slice(0, 8);

    const {
      rows: [host],
    } = await sql(
      `INSERT INTO "User" (email, name, roles, "hostVerificationStatus", "updatedAt")
       VALUES ($1, $2, '{HOST}', 'VERIFIED', now()) RETURNING id`,
      [`payout-host-${run}@test.local`, `Payout Host ${run}`],
    );

    const listingTitle = `Payout Bay ${run}`;
    const {
      rows: [listing],
    } = await sql(
      `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
         "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
         "accessInstructions", status, "updatedAt")
       VALUES ($1, $2, 'Open driveway', '21 Residency Road', 'Richmond Town', 12.96, 77.60,
         12.961, 77.601, 'DRIVEWAY', '{SUV}', 5000, 'Drive straight in', 'PUBLISHED', now()) RETURNING id`,
      [host.id, listingTitle],
    );

    const {
      rows: [renter],
    } = await sql(
      `INSERT INTO "User" (email, name, roles, "updatedAt")
       VALUES ($1, $2, '{RENTER}', now()) RETURNING id`,
      [`payout-renter-${run}@test.local`, `Payout Renter ${run}`],
    );

    // Booking checked out 72h ago (outside 24h hold-back)
    const {
      rows: [booking],
    } = await sql(
      `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
         "blockedUntil", status, "subtotalPaise", "commissionPaise", "hostEarningsPaise",
         "totalPaise", "checkedOutAt", "updatedAt")
       VALUES ($1, $2, 'HOURLY', now() - interval '74 hours', now() - interval '72 hours',
         now() - interval '72 hours', 'COMPLETED', 100000, 10000, 90000, 100000,
         now() - interval '72 hours', now()) RETURNING id`,
      [listing.id, renter.id],
    );

    const ref = `pay_e2e_${run}`;
    await sql(
      `INSERT INTO "LedgerEntry" ("bookingId", account, "amountPaise", reference, "updatedAt")
       VALUES ($1, 'RENTER_PAYMENT', 100000, $2, now()),
              ($1, 'PLATFORM_COMMISSION', 10000, $2, now()),
              ($1, 'HOST_EARNINGS', 90000, $2, now())`,
      [booking.id, ref],
    );

    await signIn(context, { roles: ["ADMIN"] });
    await page.goto("/admin/payouts");

    // Open Create Payout dialog
    await page.getByRole("button", { name: "Create Payout" }).click();

    // Fill Host ID and fetch bookings
    await page.locator("#create-host-id").fill(host.id);
    await page.getByRole("button", { name: "Fetch Bookings" }).click();

    // Ensure the booking checkbox is selected
    const checkbox = page.getByRole("checkbox").first();
    await expect(checkbox).toBeVisible();
    await checkbox.check();

    // Fill payout batch reason
    const createReason = page.getByPlaceholder(
      /Weekly host payout settlement for completed bookings/i,
    );
    await createReason.fill("Weekly scheduled batch settlement for verified host earnings");

    // Submit payout creation
    await page.getByRole("button", { name: "Create Payout Batch" }).click();
    await expect(page.getByText(/Payout created in PENDING status/i)).toBeVisible();

    // On Payouts Queue, locate the pending payout row for this host
    const pendingRow = page.locator("tr").filter({ hasText: host.id.slice(0, 8) }).first();
    await expect(pendingRow).toBeVisible();

    // Click Mark Paid
    await pendingRow.getByRole("button", { name: "Mark Paid" }).click();

    // Fill provider reference
    const bankRef = `UTR${run.toUpperCase()}`;
    await page.locator("#provider-ref").fill(bankRef);

    // Fill settlement audit reason
    const markPaidReason = page.getByPlaceholder(
      /HDFC Bank IMPS transfer processed successfully/i,
    );
    await markPaidReason.fill("Axis Bank IMPS transfer verified and settlement recorded");

    // Confirm settlement
    await page.getByRole("button", { name: "Record Paid Reference" }).click();
    await expect(page.getByText(/Payout marked as PAID/i)).toBeVisible();

    // Verify HostPayout row in PostgreSQL
    const {
      rows: [payout],
    } = await sql(
      `SELECT status, "providerReference", "paidAt" FROM "HostPayout" WHERE "hostId" = $1`,
      [host.id],
    );
    expect(payout.status).toBe("PAID");
    expect(payout.providerReference).toBe(bankRef);
    expect(payout.paidAt).not.toBeNull();
  });

  test("queue page passes accessibility check", async ({ page, context }) => {
    await signIn(context, { roles: ["ADMIN"] });
    await page.goto("/admin/disputes");
    await expect(page.getByRole("heading", { name: "Disputes Queue & Resolution" })).toBeVisible();

    // Await data load completion before auditing accessibility
    await expect(page.getByLabel(/Loading/i)).not.toBeVisible();
    await expect(page.locator("table").or(page.getByText("No disputes found"))).toBeVisible();

    // Verify 0 serious/critical axe violations on queue page
    await expectAccessible(page);
  });
});
