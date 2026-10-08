import { z } from "zod";
import { RentalType, SpaceType, VehicleType } from "../generated/prisma/enums";
import { IsoDateTime, PaginationQuery, page } from "./common";
import { ListingCard } from "./listings";

// FR-03. Query values arrive as strings, so numbers are coerced and booleans use
// stringbool ("true"/"false"). A repeated key keeps only its last value, so
// multi-value filters are comma-separated strings.

/** "a,b,c" -> ["a","b","c"] */
const splitComma = z.string().transform((s) => s.split(",").filter(Boolean));

/**
 * GET /api/listings. Give either a viewport (minLat..maxLng, after "Search this area")
 * or a centre (lat, lng, radiusMeters). With startAt/endAt, results are checked
 * against that interval, not just publication status.
 */
export const SearchListingsQuery = PaginationQuery.extend({
  minLat: z.coerce.number().min(-90).max(90).optional(),
  minLng: z.coerce.number().min(-180).max(180).optional(),
  maxLat: z.coerce.number().min(-90).max(90).optional(),
  maxLng: z.coerce.number().min(-180).max(180).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusMeters: z.coerce.number().int().min(100).max(50_000).optional(),
  startAt: IsoDateTime.optional(),
  endAt: IsoDateTime.optional(),
  rentalType: z.enum(RentalType).optional(),
  /** Unit price range for `rentalType` (or the lowest offered unit price without one). */
  minPricePaise: z.coerce.number().int().min(0).optional(),
  maxPricePaise: z.coerce.number().int().min(0).optional(),
  vehicleType: z.enum(VehicleType).optional(),
  spaceTypes: splitComma.pipe(z.array(z.enum(SpaceType))).optional(),
  covered: z.stringbool().optional(),
  /** The renter's vehicle size: listings whose set limit is smaller are excluded. */
  minHeightCm: z.coerce.number().int().positive().optional(),
  minWidthCm: z.coerce.number().int().positive().optional(),
  minLengthCm: z.coerce.number().int().positive().optional(),
  amenities: splitComma.pipe(z.array(z.enum(["lit", "evCharging", "security"]))).optional(),
  sort: z.enum(["distance", "price"]).default("distance"),
});
export type SearchListingsQuery = z.infer<typeof SearchListingsQuery>;

export const SearchListingsResponse = page(ListingCard);
export type SearchListingsResponse = z.infer<typeof SearchListingsResponse>;
