import { randomUUID } from "node:crypto";
import { expect as baseExpect, test } from "@playwright/test";
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

/**
 * A COMPLETED ₹1000 booking with T4.1's confirm-time ledger (commission ₹100, host ₹900),
 * checked out `hoursAgo` hours ago.
 */
async function completedBooking(listingId: string, renterId: string, hoursAgo: number) {
  const {
    rows: [b],
  } = await sql(
    `INSERT INTO "Booking" ("listingId", "renterId", "rentalType", "startAt", "endAt",
       "blockedUntil", status, "subtotalPaise", "commissionPaise", "hostEarningsPaise",
       "totalPaise", "checkedOutAt", "updatedAt")
     VALUES ($1, $2, 'HOURLY', now() - make_interval(hours => $3 + 2),
       now() - make_interval(hours => $3), now() - make_interval(hours => $3), 'COMPLETED',
       100000, 10000, 90000, 100000, now() - make_interval(hours => $3), now()) RETURNING id`,
    [listingId, renterId, hoursAgo],
  );
  const ref = `pay_e2e_${randomUUID().slice(0, 8)}`;
  await sql(
    `INSERT INTO "LedgerEntry" ("bookingId", account, "amountPaise", reference, "updatedAt")
     VALUES ($1, 'RENTER_PAYMENT', 100000, $2, now()), ($1, 'PLATFORM_COMMISSION', 10000, $2, now()),
            ($1, 'HOST_EARNINGS', 90000, $2, now())`,
    [b.id, ref],
  );
  return b.id as string;
}

test("a host with completed bookings sees pending, payable, and paid totals", async ({
  page,
  context,
}) => {
  const { userId: hostId } = await signIn(context, {
    roles: ["RENTER", "HOST"],
    hostVerificationStatus: "VERIFIED",
  });
  const run = randomUUID().slice(0, 8);
  const {
    rows: [listing],
  } = await sql(
    `INSERT INTO "Listing" ("hostId", title, description, address, locality, lat, lng,
       "approxLat", "approxLng", "spaceType", "vehicleTypes", "hourlyPaise",
       "accessInstructions", status, "updatedAt")
     VALUES ($1, $2, 'Covered', $3, 'Shivajinagar', 18.53, 73.84, 18.531, 73.84, 'STILT',
       '{SEDAN}', 5000, 'Gate code 4321', 'PUBLISHED', now()) RETURNING id`,
    [hostId, `Earnings bay ${run}`, `12 FC Road ${run}`],
  );
  const {
    rows: [renter],
  } = await sql(
    `INSERT INTO "User" (email, roles, "updatedAt") VALUES ($1, '{RENTER}', now()) RETURNING id`,
    [`e2e-renter-${run}@test.local`],
  );

  await completedBooking(listing.id, renter.id, 1); // inside the 24h hold-back: pending
  await completedBooking(listing.id, renter.id, 72); // payable
  const paid = await completedBooking(listing.id, renter.id, 120);
  const ref = `UTR${run}`;
  const {
    rows: [payout],
  } = await sql(
    `INSERT INTO "HostPayout" ("hostId", "amountPaise", status, "providerReference",
       "idempotencyKey", "paidAt", "updatedAt")
     VALUES ($1, 90000, 'PAID', $2, $3, now(), now()) RETURNING id`,
    [hostId, ref, `e2e:${run}`],
  );
  await sql(`UPDATE "Booking" SET "hostPayoutId" = $1 WHERE id = $2`, [payout.id, paid]);

  await page.goto("/host");
  await page.getByRole("link", { name: "Earnings and payouts" }).click();
  await expect(page.getByRole("heading", { name: "Earnings and payouts" })).toBeVisible();
  await expect(page.getByText("Payouts are processed manually by ParkShare")).toBeVisible();

  const totals = page.locator("dl");
  for (const label of ["Pending", "Payable", "Paid"])
    await expect(
      totals.locator("div").filter({ has: page.getByText(label, { exact: true }) }),
    ).toContainText("₹900");
  await expect(page.getByText(/3 paid bookings: gross ₹3,000/)).toBeVisible();
  await expect(page.getByRole("cell", { name: ref })).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
  expect(bad.map((v) => v.id)).toEqual([]);
});
