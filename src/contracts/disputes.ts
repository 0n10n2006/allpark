import { z } from "zod";
import { DisputeCategory, DisputeStatus } from "../generated/prisma/enums";
import { IsoDateTime, Uuid } from "./common";

// FR-08, FR-10. Evidence URLs must point at our Cloudinary uploads (checked by the handler).

export const Dispute = z.object({
  id: Uuid,
  bookingId: Uuid,
  raisedById: Uuid,
  category: z.enum(DisputeCategory),
  description: z.string(),
  evidenceUrls: z.array(z.url()),
  status: z.enum(DisputeStatus),
  resolution: z.string().nullable(),
  resolvedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Dispute = z.infer<typeof Dispute>;

/** POST /api/disputes. Renter or host of the booking. */
export const CreateDisputeBody = z.strictObject({
  bookingId: Uuid,
  category: z.enum(DisputeCategory),
  description: z.string().trim().min(10).max(5000),
  evidenceUrls: z.array(z.url()).max(10).optional(),
});
export type CreateDisputeBody = z.infer<typeof CreateDisputeBody>;
