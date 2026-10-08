import type { OwnedListing } from "@/contracts";
import { formatINR } from "@/lib/money";

export const SPACE_TYPES = {
  OPEN: "Open-air",
  COVERED: "Covered",
  GARAGE: "Garage",
  BASEMENT: "Basement",
  STILT: "Stilt",
  DRIVEWAY: "Driveway",
} as const;

export const VEHICLE_TYPES = {
  TWO_WHEELER: "Two-wheeler",
  HATCHBACK: "Hatchback",
  SEDAN: "Sedan",
  SUV: "SUV",
  VAN: "Van",
} as const;

export const STATUS_LABELS: Record<OwnedListing["status"], string> = {
  DRAFT: "Draft",
  PENDING_REVIEW: "In review",
  PUBLISHED: "Published",
  SUSPENDED: "Suspended",
  ARCHIVED: "Archived",
};

const UNITS = { hourly: "hour", daily: "day", weekly: "week", monthly: "month" } as const;

/** "₹40 / hour" for the cheapest offered rental type, or null when nothing is priced. */
export function priceFrom(prices: OwnedListing["prices"]): string | null {
  const offered = (Object.keys(UNITS) as (keyof typeof UNITS)[])
    .map((k) => [k, prices[k]?.paise] as const)
    .filter((e): e is readonly [keyof typeof UNITS, number] => typeof e[1] === "number");
  if (!offered.length) return null;
  const [unit, paise] = offered.reduce((a, b) => (b[1] < a[1] ? b : a));
  return `${formatINR(paise)} / ${UNITS[unit]}`;
}
