// Local stand-ins: replace with getActivePolicy() from src/config/policy.ts (T2.2).

/** Pune bounding box (plan §2.2 `cityBoundary`); publish rejects coords outside it. */
export const CITY_BOUNDARY = { minLat: 18.4, maxLat: 18.7, minLng: 73.7, maxLng: 74.05 };

/** Human-readable terms per cancellation policy key, shown before payment (FR-10). */
export const CANCELLATION_SUMMARIES: Record<string, string> = {
  standard:
    "Hourly: full refund up to 2 h before start. Daily: full refund up to 24 h before, 50% up to 2 h before. Monthly: full refund up to 7 days before. No refund after that.",
};
