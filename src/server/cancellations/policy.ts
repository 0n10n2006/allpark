import type { Policy } from "@/config/policy";
import type { RentalType } from "@/generated/prisma/enums";

const HOUR = 3_600_000;

/**
 * FR-10 renter cancellation: the first tier (ordered by minHoursBefore desc) whose
 * threshold the time-to-start meets. After the start nothing qualifies, so 0.
 * Unknown policy keys fall back to "standard", as cancellationText does.
 */
export function computeCancellationRefund(input: {
  policy: Pick<Policy, "cancellationPolicy">;
  policyKey: string;
  rentalType: RentalType;
  startAt: Date;
  now: Date;
  paidPaise: number;
}): { refundPaise: number; refundBps: number } {
  const table =
    input.policy.cancellationPolicy[input.policyKey] ?? input.policy.cancellationPolicy.standard;
  const hoursBefore = (input.startAt.getTime() - input.now.getTime()) / HOUR;
  const tier =
    hoursBefore < 0
      ? undefined
      : table[input.rentalType].find((t) => hoursBefore >= t.minHoursBefore);
  const refundBps = tier?.refundBps ?? 0;
  return { refundPaise: Math.floor((input.paidPaise * refundBps) / 10_000), refundBps };
}
