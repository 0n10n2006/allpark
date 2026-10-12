import { z } from "zod";
import { ModerationStatus } from "../generated/prisma/enums";
import { IsoDateTime, Uuid } from "./common";

// FR-11. Only the renter of a COMPLETED booking may review it, once.

export const Review = z.object({
  id: Uuid,
  bookingId: Uuid,
  listingId: Uuid,
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  moderationStatus: z.enum(ModerationStatus),
  createdAt: IsoDateTime,
});
export type Review = z.infer<typeof Review>;

/** POST /api/reviews */
export const CreateReviewBody = z.strictObject({
  bookingId: Uuid,
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
export type CreateReviewBody = z.infer<typeof CreateReviewBody>;

export const ListingReviewItem = z.strictObject({
  id: Uuid,
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  createdAt: IsoDateTime,
  reviewerFirstName: z.string().nullable(),
});
export type ListingReviewItem = z.infer<typeof ListingReviewItem>;

export const ListingRatingSummary = z.strictObject({
  average: z.number().min(1).max(5).nullable(),
  count: z.number().int().min(0),
});
export type ListingRatingSummary = z.infer<typeof ListingRatingSummary>;

/** GET /api/listings/:id/reviews */
export const ListListingReviewsResponse = z.strictObject({
  items: z.array(ListingReviewItem),
  nextCursor: z.string().nullable(),
  rating: ListingRatingSummary,
  summary: ListingRatingSummary,
});
export type ListListingReviewsResponse = z.infer<typeof ListListingReviewsResponse>;
