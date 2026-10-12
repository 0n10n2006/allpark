import { describe, expect, test } from "vitest";
import { POLICY_DEFAULTS } from "@/config/policy";
import type { RentalType } from "@/generated/prisma/enums";
import { computeCancellationRefund } from "@/server/cancellations/policy";

const HOUR = 3_600_000;
const startAt = new Date("2030-01-07T10:00:00Z");
const at = (hoursBefore: number) => new Date(startAt.getTime() - hoursBefore * HOUR);
const refund = (
  rentalType: RentalType,
  hoursBefore: number,
  paidPaise = 100_000,
  policyKey = "standard",
) =>
  computeCancellationRefund({
    policy: POLICY_DEFAULTS,
    policyKey,
    rentalType,
    startAt,
    now: at(hoursBefore),
    paidPaise,
  }).refundPaise;

const ms = 1 / HOUR; // one millisecond, in hours

describe("computeCancellationRefund (standard placeholder tiers)", () => {
  test.each<[RentalType, number, number]>([
    ["HOURLY", 100, 100_000],
    ["HOURLY", 2, 100_000],
    ["HOURLY", 2 - ms, 0],
    ["HOURLY", 0, 0],
    ["DAILY", 24, 100_000],
    ["DAILY", 24 - ms, 50_000],
    ["DAILY", 2, 50_000],
    ["DAILY", 2 - ms, 0],
    ["MULTI_DAY", 48, 100_000],
    ["MULTI_DAY", 48 - ms, 50_000],
    ["MULTI_DAY", 24, 50_000],
    ["MULTI_DAY", 24 - ms, 0],
    ["WEEKLY", 72, 100_000],
    ["WEEKLY", 72 - ms, 50_000],
    ["WEEKLY", 24, 50_000],
    ["WEEKLY", 24 - ms, 0],
    ["MONTHLY", 168, 100_000],
    ["MONTHLY", 168 - ms, 0],
  ])("%s cancelled %s h before start → %s paise", (type, hours, expected) => {
    expect(refund(type, hours)).toBe(expected);
  });

  test("after the start nothing is refunded, even on a 0-hour tier", () => {
    for (const t of ["HOURLY", "DAILY", "MULTI_DAY", "WEEKLY", "MONTHLY"] as const)
      expect(refund(t, -1)).toBe(0);
  });

  test("50% of an odd amount rounds down to whole paise", () => {
    expect(refund("DAILY", 10, 100_001)).toBe(50_000);
  });

  test("an unknown policy key falls back to standard", () => {
    expect(refund("HOURLY", 3, 100_000, "nope")).toBe(100_000);
  });
});
