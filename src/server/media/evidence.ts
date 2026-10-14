import type { CurrentUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { signFolderUpload } from "@/server/listings/cloudinary";

// FR-07/FR-11 evidence photos: signed direct uploads into incidents/<bookingId>/, and the
// one check for "is this URL our upload for this booking" used by incidents and disputes.

export const evidenceFolder = (bookingId: string) => `incidents/${bookingId}`;

/** POST /api/bookings/:id/evidence/sign. Renter or host; anyone else gets 404. Null when Cloudinary isn't configured. */
export async function signEvidenceUpload(user: CurrentUser, bookingId: string) {
  const b = await db.booking.findUnique({
    where: { id: bookingId },
    select: { renterId: true, listing: { select: { hostId: true } } },
  });
  if (!b || (b.renterId !== user.id && b.listing.hostId !== user.id))
    throw new HttpError("not_found", "Booking not found");
  return signFolderUpload(evidenceFolder(bookingId));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A delivery URL of our own Cloudinary upload directly in `folder` (not /image/fetch/<remote>). */
export function isOurUploadUrl(url: string, folder: string) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud) return false;
  return new RegExp(
    `^https://res\\.cloudinary\\.com/${esc(cloud)}/image/upload/(?:v\\d+/)?${esc(folder)}/[A-Za-z0-9_-]+\\.(?:jpg|png|webp)$`,
  ).test(url);
}

/** Booking evidence: uploaded via the sign route (incidents/) or the older disputes/ folder. */
export const isOurEvidenceUrl = (url: string, bookingId: string) =>
  isOurUploadUrl(url, evidenceFolder(bookingId)) || isOurUploadUrl(url, `disputes/${bookingId}`);
