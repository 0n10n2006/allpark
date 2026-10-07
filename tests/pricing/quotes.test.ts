import { testDb, truncateAll } from "../setup/db";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Quote } from "@/contracts";
import { noParams, req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { POST } = await import("@/app/api/quotes/route");
const { validateQuote } = await import("@/server/pricing/quotes");
const { getActivePolicy, POLICY_DEFAULTS } = await import("@/config/policy");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

const HOUR = 3_600_000;
const startAt = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR);
const endAt = new Date(startAt.getTime() + 2 * HOUR);

async function seedListing(overrides: { status?: "PUBLISHED" | "DRAFT" } = {}) {
  const host = await testDb.user.create({
    data: { email: `${crypto.randomUUID()}@test.local`, roles: ["HOST"] },
  });
  return testDb.listing.create({
    data: {
      hostId: host.id,
      title: "Stilt bay",
      description: "Covered",
      address: "12 FC Road",
      locality: "Shivajinagar",
      lat: 18.53,
      lng: 73.84,
      approxLat: 18.531,
      approxLng: 73.84,
      spaceType: "STILT",
      vehicleTypes: ["SEDAN"],
      hourlyPaise: 50_000,
      status: overrides.status ?? "PUBLISHED",
    },
  });
}

const quote = (cookie: string | undefined, body: Record<string, unknown>) =>
  POST(req("/api/quotes", { method: "POST", cookie, body }), noParams);

const body = (listingId: string) => ({
  listingId,
  rentalType: "HOURLY",
  startAt: startAt.toISOString(),
  endAt: endAt.toISOString(),
});

describe("POST /api/quotes", () => {
  test("signed out → 401", async () => {
    const listing = await seedListing();
    expect((await quote(undefined, body(listing.id))).status).toBe(401);
  });

  test("prices server-side, persists the quote, returns the contract shape with terms", async () => {
    const { user, cookie } = await seedSession();
    const listing = await seedListing();
    const res = await quote(cookie, body(listing.id));
    expect(res.status).toBe(200);
    const q = Quote.parse(await res.json());
    expect(q.total).toEqual({ paise: 100_000, currency: "INR" });
    expect(q.vehicleId).toBeNull();
    expect(q.policyVersion).toBe(1);
    expect(q.terms.gracePeriodMinutes).toBe(10);
    expect(q.terms.cancellation).toMatch(/refund/i);
    expect(q.terms.overstay).toMatch(/grace period/);
    const expiresIn = new Date(q.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(14 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(15 * 60_000);

    const row = await testDb.priceQuote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row).toMatchObject({
      renterId: user.id,
      subtotalPaise: 100_000,
      commissionPaise: 10_000,
      hostEarningsPaise: 90_000,
      totalPaise: 100_000,
      currency: "INR",
    });
  });

  test("a client-sent amount is rejected (400), never priced", async () => {
    const { cookie } = await seedSession();
    const listing = await seedListing();
    const res = await quote(cookie, { ...body(listing.id), totalPaise: 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_error");
    expect(await testDb.priceQuote.count()).toBe(0);
  });

  test("unpublished listing → 404, same as missing", async () => {
    const { cookie } = await seedSession();
    const draft = await seedListing({ status: "DRAFT" });
    expect((await quote(cookie, body(draft.id))).status).toBe(404);
    expect((await quote(cookie, body(crypto.randomUUID()))).status).toBe(404);
  });

  test("another user's vehicle → 404", async () => {
    const { cookie } = await seedSession();
    const other = await seedSession();
    const listing = await seedListing();
    const vehicle = await testDb.vehicle.create({
      data: { userId: other.user.id, registration: "MH12AB1234", type: "SEDAN" },
    });
    const res = await quote(cookie, { ...body(listing.id), vehicleId: vehicle.id });
    expect(res.status).toBe(404);
  });

  test("rental type the listing doesn't offer → 422", async () => {
    const { cookie } = await seedSession();
    const listing = await seedListing();
    const res = await quote(cookie, { ...body(listing.id), rentalType: "MONTHLY" });
    expect(res.status).toBe(422);
  });
});

describe("getActivePolicy", () => {
  test("creates v1 from defaults on an empty DB, then merges the latest row over defaults", async () => {
    expect(await getActivePolicy()).toMatchObject({ ...POLICY_DEFAULTS, version: 1 });
    await testDb.policyVersion.create({
      data: { version: 2, policy: { commissionBps: 1200 }, effectiveAt: new Date() },
    });
    const p = await getActivePolicy();
    expect(p).toMatchObject({ version: 2, commissionBps: 1200, holdTtlMinutes: 10 });
    expect(p.gracePeriodMinutes).toBe(10);
  });
});

describe("validateQuote", () => {
  async function seedQuote() {
    const s = await seedSession();
    const listing = await seedListing();
    const q = Quote.parse(await (await quote(s.cookie, body(listing.id))).json());
    return { ...s, listing, q };
  }
  const expect422 = async (p: Promise<unknown>) =>
    expect(p).rejects.toMatchObject({ status: 422, code: "unprocessable" });

  test("a fresh, matching quote passes", async () => {
    const { user, listing, q } = await seedQuote();
    const row = await validateQuote(q.id, user.id, listing.id, "HOURLY", { startAt, endAt });
    expect(row.totalPaise).toBe(100_000);
    // ISO strings work too.
    await validateQuote(q.id, user.id, listing.id, "HOURLY", {
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
    });
  });

  test("an expired quote fails", async () => {
    const { user, listing, q } = await seedQuote();
    await testDb.priceQuote.update({
      where: { id: q.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect422(validateQuote(q.id, user.id, listing.id, "HOURLY", { startAt, endAt }));
  });

  test("another user's quote fails like a missing one", async () => {
    const { listing, q } = await seedQuote();
    const other = await seedSession();
    await expect(
      validateQuote(q.id, other.user.id, listing.id, "HOURLY", { startAt, endAt }),
    ).rejects.toThrow("Quote not found");
    await expect422(
      validateQuote(crypto.randomUUID(), other.user.id, listing.id, "HOURLY", { startAt, endAt }),
    );
    await expect422(
      validateQuote("not-a-uuid", other.user.id, listing.id, "HOURLY", { startAt, endAt }),
    );
  });

  test("mismatched listing, rental type, or interval fails", async () => {
    const { user, listing, q } = await seedQuote();
    const later = new Date(endAt.getTime() + HOUR);
    await expect422(
      validateQuote(q.id, user.id, crypto.randomUUID(), "HOURLY", { startAt, endAt }),
    );
    await expect422(validateQuote(q.id, user.id, listing.id, "DAILY", { startAt, endAt }));
    await expect422(validateQuote(q.id, user.id, listing.id, "HOURLY", { startAt, endAt: later }));
  });
});
