// The /explore URL uses GET /api/listings' own query keys, so the page URL is shareable
// and the fetch is a passthrough. `q` is only the area's display label.

export const AREA_KEYS = [
  "q",
  "lat",
  "lng",
  "radiusMeters",
  "minLat",
  "minLng",
  "maxLat",
  "maxLng",
];
export const FILTER_KEYS = [
  "rentalType",
  "startAt",
  "endAt",
  "minPricePaise",
  "maxPricePaise",
  "vehicleType",
  "minHeightCm",
  "covered",
  "amenities",
];
/** Radius for a locality or "near me" search. */
export const AREA_RADIUS_M = 3000;
export const PAGE_SIZE = 20;

/** Query string for GET /api/listings from the page's search params. */
export function apiQuery(params: URLSearchParams, cursor?: string | null): string {
  const out = new URLSearchParams();
  for (const [k, v] of params)
    if (k !== "q" && (AREA_KEYS.includes(k) || FILTER_KEYS.includes(k))) out.set(k, v);
  out.set("limit", String(PAGE_SIZE));
  if (cursor) out.set("cursor", cursor);
  return out.toString();
}

/** Copy of `params` with the area replaced (filters kept). */
export function withArea(params: URLSearchParams, area: Record<string, string | number>) {
  const next = new URLSearchParams(params);
  for (const k of AREA_KEYS) next.delete(k);
  for (const [k, v] of Object.entries(area)) next.set(k, String(v));
  return next;
}

/** Copy of `params` with every filter replaced (area kept). */
export function withFilters(params: URLSearchParams, filters: Record<string, string | undefined>) {
  const next = new URLSearchParams(params);
  for (const k of FILTER_KEYS) next.delete(k);
  for (const [k, v] of Object.entries(filters)) if (v) next.set(k, v);
  return next;
}

/** Badge count: the time window counts once, each amenity once. */
export function filterCount(params: URLSearchParams): number {
  let n = 0;
  for (const k of FILTER_KEYS) {
    if (!params.get(k) || k === "endAt") continue;
    n += k === "amenities" ? params.get(k)!.split(",").filter(Boolean).length : 1;
  }
  return n;
}

type Bounds = { west: number; south: number; east: number; north: number };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * "Search this area": the map viewport as the API's bbox. Rounded outward to 4 decimals
 * (~11 m) so edge pins stay in and the URL stays short; clamped to valid lat/lng.
 */
export function bboxFromBounds(b: Bounds) {
  const down = (v: number) => Math.floor(v * 1e4) / 1e4;
  const up = (v: number) => Math.ceil(v * 1e4) / 1e4;
  return {
    minLat: clamp(down(b.south), -90, 90),
    minLng: clamp(down(b.west), -180, 180),
    maxLat: clamp(up(b.north), -90, 90),
    maxLng: clamp(up(b.east), -180, 180),
  };
}

/** The search centre, if the area is a point search; used to recentre the map. */
export function areaCentre(params: URLSearchParams) {
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  return params.has("lat") && params.has("lng") && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng }
    : null;
}
