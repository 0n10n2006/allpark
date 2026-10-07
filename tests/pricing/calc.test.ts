import { describe, expect, test } from "vitest";
import type { RentalType } from "@/generated/prisma/enums";
import { bpsOf, type PricedListing, priceFor } from "@/server/pricing/calc";
import { HttpError } from "@/server/http/errors";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const fees = { commissionBps: 1000, renterFeeBps: 0 };
const listing: PricedListing = {
  hourlyPaise: 10_000,
  dailyPaise: 10_000,
  weeklyPaise: 50_000,
  monthlyPaise: 300_000,
  minDurationMinutes: 60,
};
// 2026-11-02 10:00 IST
const start = new Date("2026-11-02T04:30:00Z");
const after = (ms: number) => new Date(start.getTime() + ms);

describe("priceFor subtotal", () => {
  test.each<[string, RentalType, number, number, Partial<PricedListing>?]>([
    ["hourly, exactly 1h", "HOURLY", HOUR, 10_000],
    ["hourly, 61 min → 2h", "HOURLY", 61 * MIN, 20_000],
    [
      "hourly, 30 min with 30 min minimum → 1h",
      "HOURLY",
      30 * MIN,
      10_000,
      { minDurationMinutes: 30 },
    ],
    ["daily, exactly 24h", "DAILY", DAY, 10_000],
    ["daily, 25h → 2 started days", "DAILY", 25 * HOUR, 20_000],
    ["multi-day, 3 days", "MULTI_DAY", 3 * DAY, 30_000],
    ["multi-day, 3 days + 1 min → 4 days", "MULTI_DAY", 3 * DAY + MIN, 40_000],
    ["weekly, exactly 1 week", "WEEKLY", 7 * DAY, 50_000],
    ["weekly, 9 days → week + 2 days", "WEEKLY", 9 * DAY, 70_000],
    ["weekly, 13 days → leftover capped at a week", "WEEKLY", 13 * DAY, 100_000],
    ["weekly, 3 days → days below the week price", "WEEKLY", 3 * DAY, 30_000],
    [
      "weekly, no daily price → leftover is a week",
      "WEEKLY",
      8 * DAY,
      100_000,
      { dailyPaise: null },
    ],
    ["monthly, exactly 1 calendar month", "MONTHLY", 30 * DAY, 300_000],
    ["monthly, 1 month + 1h → 2 terms", "MONTHLY", 30 * DAY + HOUR, 600_000],
  ])("%s", (_name, type, ms, subtotal, overrides) => {
    const p = priceFor({ ...listing, ...overrides }, type, start, after(ms), fees);
    expect(p.subtotalPaise).toBe(subtotal);
    expect(p.lineItems.reduce((s, i) => s + i.amount.paise, 0)).toBe(p.totalPaise);
    expect(p.lineItems.every((i) => Number.isInteger(i.amount.paise))).toBe(true);
  });

  test("monthly terms follow IST calendar months (Jan 31 → Feb 28)", () => {
    const jan31 = new Date("2027-01-31T04:30:00Z");
    const p = priceFor(listing, "MONTHLY", jan31, new Date("2027-02-28T04:30:00Z"), fees);
    expect(p.subtotalPaise).toBe(300_000);
  });

  test.each<[string, RentalType, number, Partial<PricedListing>]>([
    ["below minimum duration", "HOURLY", 59 * MIN, {}],
    ["rental type not offered", "HOURLY", HOUR, { hourlyPaise: null }],
    ["multi-day without a daily price", "MULTI_DAY", DAY, { dailyPaise: null }],
    ["end before start", "HOURLY", -HOUR, {}],
    ["zero length", "HOURLY", 0, { minDurationMinutes: 0 }],
    ["longer than 400 days", "DAILY", 401 * DAY, {}],
  ])("rejects %s with 422", (_name, type, ms, overrides) => {
    let err: unknown;
    try {
      priceFor({ ...listing, ...overrides }, type, start, after(ms), fees);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
  });
});

describe("commission and fees", () => {
  test("₹500 → ₹50 commission → ₹450 host earnings (PRD FR-05)", () => {
    const p = priceFor({ ...listing, hourlyPaise: 50_000 }, "HOURLY", start, after(HOUR), fees);
    expect(p).toMatchObject({
      subtotalPaise: 50_000,
      commissionPaise: 5_000,
      hostEarningsPaise: 45_000,
      renterFeePaise: 0,
      taxPaise: 0,
      totalPaise: 50_000,
    });
    // Commission is host-side: never a renter line item.
    expect(p.lineItems.map((i) => i.code)).toEqual(["hourly", "renter_fee", "tax"]);
  });

  test.each([
    [5, 1000, 1], // 0.5 → 1
    [15, 1000, 2], // 1.5 → 2
    [14, 1000, 1], // 1.4 → 1
    [4, 1000, 0], // 0.4 → 0
    [10_005, 1000, 1001], // 1000.5 → 1001
  ])("round-half-up: %i paise × %i bps → %i", (amount, bps, expected) => {
    expect(bpsOf(amount, bps)).toBe(expected);
  });

  test("odd-paise subtotal rounds commission half up and still reconciles", () => {
    const p = priceFor({ ...listing, hourlyPaise: 10_005 }, "HOURLY", start, after(HOUR), fees);
    expect(p.commissionPaise).toBe(1001);
    expect(p.hostEarningsPaise + p.commissionPaise).toBe(p.subtotalPaise);
  });

  test("a renter fee, when configured, is a fee line item added to the total", () => {
    const p = priceFor(listing, "HOURLY", start, after(HOUR), { ...fees, renterFeeBps: 250 });
    expect(p.renterFeePaise).toBe(250);
    expect(p.totalPaise).toBe(10_250);
    expect(p.lineItems.find((i) => i.code === "renter_fee")).toMatchObject({ kind: "fee" });
  });
});
