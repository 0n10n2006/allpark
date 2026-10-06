import type { RentalType } from "@/generated/prisma/enums";
import { db } from "@/server/db";

// Plan §2.2: open PRD decisions as config with placeholder defaults. A PolicyVersion row
// overrides these field by field; every quote snapshots the version it was priced under.

export type CancellationTier = { minHoursBefore: number; refundBps: number };

export const POLICY_DEFAULTS = {
  commissionBps: 1000,
  renterFeeBps: 0,
  holdTtlMinutes: 10,
  gracePeriodMinutes: 10,
  reminderOffsetsMinutes: [30, 10],
  overstayFeeEnabled: false,
  /** Keyed by Listing.cancellationPolicy, then rental type; tiers ordered by minHoursBefore desc. */
  cancellationPolicy: {
    standard: {
      HOURLY: [
        { minHoursBefore: 2, refundBps: 10000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      DAILY: [
        { minHoursBefore: 24, refundBps: 10000 },
        { minHoursBefore: 2, refundBps: 5000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      MULTI_DAY: [
        { minHoursBefore: 48, refundBps: 10000 },
        { minHoursBefore: 24, refundBps: 5000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      WEEKLY: [
        { minHoursBefore: 72, refundBps: 10000 },
        { minHoursBefore: 24, refundBps: 5000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
      MONTHLY: [
        { minHoursBefore: 168, refundBps: 10000 },
        { minHoursBefore: 0, refundBps: 0 },
      ],
    },
  } as Record<string, Record<RentalType, CancellationTier[]>>,
  monthlyRenewalReminderDays: 7,
  unpaidGraceDays: 0,
  payoutMode: "MANUAL" as "MANUAL" | "AUTO",
  cityBoundary: { minLat: 18.4, maxLat: 18.7, minLng: 73.7, maxLng: 74.05 },
};

export type Policy = typeof POLICY_DEFAULTS;
export type ActivePolicy = Policy & { id: string; version: number };

/**
 * Latest effective PolicyVersion merged over the defaults. If no row exists yet (fresh
 * DB), version 1 is created from the defaults, because quotes need a version to reference.
 */
export async function getActivePolicy(now = new Date()): Promise<ActivePolicy> {
  const row =
    (await db.policyVersion.findFirst({
      where: { effectiveAt: { lte: now } },
      orderBy: { version: "desc" },
    })) ??
    (await db.policyVersion.upsert({
      where: { version: 1 },
      create: { version: 1, policy: POLICY_DEFAULTS, effectiveAt: new Date(0) },
      update: {},
    }));
  return {
    ...POLICY_DEFAULTS,
    ...(row.policy as Partial<Policy>),
    id: row.id,
    version: row.version,
  };
}
