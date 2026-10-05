import { z } from "zod";
import { ListingStatus, SpaceType, VehicleType } from "../generated/prisma/enums";
import { IsoDateTime, Money, Paise, Uuid, page } from "./common";

// FR-02 listing management. Privacy (FR-01 AC4, FR-03): public shapes carry only
// `locality` + approxLat/approxLng. Address, exact coords, and access instructions
// appear only on the owner/admin shapes here and on BookingAccessDetails (bookings.ts).

export const ListingPhoto = z.object({ id: Uuid, url: z.url(), position: z.number().int().min(0) });
export type ListingPhoto = z.infer<typeof ListingPhoto>;

/** Prices per rental type the listing offers; null = not offered. */
export const ListingPrices = z.object({
  hourly: Money.nullable(),
  daily: Money.nullable(),
  weekly: Money.nullable(),
  monthly: Money.nullable(),
});
export type ListingPrices = z.infer<typeof ListingPrices>;

const Dimensions = {
  maxHeightCm: z.number().int().positive().nullable(),
  maxWidthCm: z.number().int().positive().nullable(),
  maxLengthCm: z.number().int().positive().nullable(),
};

const Amenities = {
  covered: z.boolean(),
  lit: z.boolean(),
  evCharging: z.boolean(),
  security: z.boolean(),
};

/** Fields every viewer may see. */
const publicFields = {
  id: Uuid,
  title: z.string(),
  description: z.string(),
  locality: z.string(),
  city: z.string(),
  /** Rounded to about 300 m. Never the real location. */
  approxLat: z.number(),
  approxLng: z.number(),
  spaceType: z.enum(SpaceType),
  vehicleTypes: z.array(z.enum(VehicleType)),
  ...Dimensions,
  ...Amenities,
  hostRules: z.string().nullable(),
  prices: ListingPrices,
  minDurationMinutes: z.number().int().positive(),
  /** Policy key plus human-readable terms shown before payment (FR-10). */
  cancellationPolicy: z.object({ key: z.string(), summary: z.string() }),
  photos: z.array(ListingPhoto),
  host: z.object({ id: Uuid, name: z.string().nullable(), verified: z.boolean() }),
  rating: z.object({
    average: z.number().min(1).max(5).nullable(),
    count: z.number().int().min(0),
  }),
};

/** GET /api/listings/:id. Strict so a private field can never slip into a public response. */
export const PublicListing = z.strictObject(publicFields);
export type PublicListing = z.infer<typeof PublicListing>;

/** Search result card / map marker (FR-03). Strict for the same reason. */
export const ListingCard = z.strictObject({
  id: Uuid,
  title: z.string(),
  locality: z.string(),
  approxLat: z.number(),
  approxLng: z.number(),
  spaceType: z.enum(SpaceType),
  vehicleTypes: z.array(z.enum(VehicleType)),
  maxHeightCm: z.number().int().positive().nullable(),
  covered: z.boolean(),
  photoUrl: z.url().nullable(),
  /** Lowest offered price (or the price for the searched rental type). */
  priceFrom: Money.nullable(),
  /** From the search centre; null when the search had no centre. */
  distanceMeters: z.number().int().min(0).nullable(),
  rating: z.object({
    average: z.number().min(1).max(5).nullable(),
    count: z.number().int().min(0),
  }),
});
export type ListingCard = z.infer<typeof ListingCard>;

/** The host's own view (and admin view). Contains private fields. */
export const OwnedListing = z.object({
  ...publicFields,
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  accessInstructions: z.string().nullable(),
  turnoverBufferMinutes: z.number().int().min(0),
  status: z.enum(ListingStatus),
  suspendedReason: z.string().nullable(),
  hostAttestedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OwnedListing = z.infer<typeof OwnedListing>;

// ── Requests ──
// No hostId or status: the server takes hostId from the session and status from the
// publish/moderation flow. Prices are the host's own asking prices, not trusted totals.

const listingInputFields = {
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(5000),
  address: z.string().trim().min(5).max(500),
  locality: z.string().trim().min(2).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  spaceType: z.enum(SpaceType),
  vehicleTypes: z.array(z.enum(VehicleType)).min(1),
  maxHeightCm: z.number().int().positive().max(1000).nullable().optional(),
  maxWidthCm: z.number().int().positive().max(1000).nullable().optional(),
  maxLengthCm: z.number().int().positive().max(2000).nullable().optional(),
  covered: z.boolean().optional(),
  lit: z.boolean().optional(),
  evCharging: z.boolean().optional(),
  security: z.boolean().optional(),
  accessInstructions: z.string().trim().max(2000).nullable().optional(),
  hostRules: z.string().trim().max(2000).nullable().optional(),
  hourlyPaise: Paise.nullable().optional(),
  dailyPaise: Paise.nullable().optional(),
  weeklyPaise: Paise.nullable().optional(),
  monthlyPaise: Paise.nullable().optional(),
  minDurationMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24 * 31)
    .optional(),
  turnoverBufferMinutes: z.number().int().min(0).max(240).optional(),
  cancellationPolicy: z.string().max(50).optional(),
};

/** POST /api/listings. Creates a DRAFT. */
export const CreateListingBody = z.strictObject(listingInputFields);
export type CreateListingBody = z.infer<typeof CreateListingBody>;

/** PATCH /api/listings/:id. Must not silently invalidate confirmed bookings (FR-02). */
export const UpdateListingBody = z.strictObject(listingInputFields).partial();
export type UpdateListingBody = z.infer<typeof UpdateListingBody>;

export const MyListingsResponse = page(OwnedListing);
export type MyListingsResponse = z.infer<typeof MyListingsResponse>;

/** POST /api/listings/:id/publish. The host attests authority to rent the space (FR-02). */
export const PublishListingBody = z.strictObject({ attestAuthority: z.literal(true) });
export type PublishListingBody = z.infer<typeof PublishListingBody>;

/** POST /api/listings/:id/photos/sign: Cloudinary signed direct-upload parameters. */
export const SignPhotoUploadBody = z.strictObject({});
export const SignPhotoUploadResponse = z.object({
  cloudName: z.string(),
  apiKey: z.string(),
  timestamp: z.number().int(),
  signature: z.string(),
  folder: z.string(),
  publicId: z.string(),
});
export type SignPhotoUploadResponse = z.infer<typeof SignPhotoUploadResponse>;

/** POST /api/listings/:id/photos: attach an uploaded image; server checks publicId is this listing's. */
export const AddListingPhotoBody = z.strictObject({
  publicId: z.string().min(1).max(300),
  position: z.number().int().min(0).max(50).optional(),
});
export type AddListingPhotoBody = z.infer<typeof AddListingPhotoBody>;
