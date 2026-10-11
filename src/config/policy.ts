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
// upsert isn't atomic in Postgres (concurrent first calls raised P2002); ON CONFLICT DO NOTHING is.
async function createDefaultPolicy() {
  await db.policyVersion.createMany({
    data: [{ version: 1, policy: POLICY_DEFAULTS, effectiveAt: new Date(0) }],
    skipDuplicates: true,
  });
  return db.policyVersion.findUniqueOrThrow({ where: { version: 1 } });
}

export async function getActivePolicy(now = new Date()): Promise<ActivePolicy> {
  const row =
    (await db.policyVersion.findFirst({
      where: { effectiveAt: { lte: now } },
      orderBy: { version: "desc" },
    })) ?? (await createDefaultPolicy());
  return {
    ...POLICY_DEFAULTS,
    ...(row.policy as Partial<Policy>),
    id: row.id,
    version: row.version,
  };
}

const RENTAL_LABEL: Record<RentalType, string> = {
  HOURLY: "Hourly",
  DAILY: "Daily",
  MULTI_DAY: "Multi-day",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
};

/**
 * Human-readable cancellation terms for a listing's policy key (FR-10). With a rental
 * type, that type's tiers; without, every type, each prefixed with its label.
 * Unknown keys fall back to "standard".
 */
export function cancellationText(policy: Policy, key: string, rentalType?: RentalType): string {
  const table = policy.cancellationPolicy[key] ?? policy.cancellationPolicy.standard;
  const tiersText = (tiers: CancellationTier[]) =>
    tiers
      .map(({ minHoursBefore, refundBps }) => {
        const refund =
          refundBps === 10000
            ? "Full refund"
            : refundBps === 0
              ? "No refund"
              : `${refundBps / 100}% refund`;
        return minHoursBefore > 0
          ? `${refund} if cancelled at least ${minHoursBefore} hours before start`
          : `${refund} if cancelled later`;
      })
      .join("; ")
      .concat(".");
  if (rentalType) return tiersText(table[rentalType]);
  return (Object.keys(RENTAL_LABEL) as RentalType[])
    .filter((t) => table[t])
    .map((t) => `${RENTAL_LABEL[t]}: ${tiersText(table[t])}`)
    .join(" ");
}

export function overstayText(policy: Policy): string {
  const grace = `A ${policy.gracePeriodMinutes}-minute grace period applies after your end time.`;
  return policy.overstayFeeEnabled
    ? `${grace} Staying longer may incur an overstay fee.`
    : `${grace} No overstay fee is charged; stay longer only by extending your booking.`;
}
