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
  comment: z.string().trim().max(2000).optional(),
});
export type CreateReviewBody = z.infer<typeof CreateReviewBody>;
