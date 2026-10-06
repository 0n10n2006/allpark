import { randomUUID } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";

// Read at call time so dev/test without Cloudinary still boots; tests mock this module.
function config() {
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey } = process.env;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  return cloudName && apiKey && apiSecret ? { cloudName, apiKey, apiSecret } : null;
}

export const ALLOWED_FORMATS = "jpg,png,webp";
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const listingFolder = (listingId: string) => `listings/${listingId}`;

/**
 * Signed direct-upload params, or null when Cloudinary isn't configured. The full
 * public_id is signed (not a `folder` param) so the resulting id is the same in fixed
 * and dynamic folder modes. Cloudinary enforces allowed_formats; the 8 MB cap is a
 * client hint only (ponytail: enforce via an upload preset if abuse shows up).
 */
export function signUpload(listingId: string) {
  const c = config();
  if (!c) return null;
  const folder = listingFolder(listingId);
  const publicId = `${folder}/${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request(
    { public_id: publicId, timestamp, allowed_formats: ALLOWED_FORMATS },
    c.apiSecret,
  );
  return {
    cloudName: c.cloudName,
    apiKey: c.apiKey,
    timestamp,
    signature,
    folder,
    publicId,
    allowedFormats: ALLOWED_FORMATS,
    maxFileBytes: MAX_FILE_BYTES,
  };
}

/** Delivery URL for an uploaded asset, or null when Cloudinary isn't configured. */
export function photoUrl(publicId: string) {
  const c = config();
  return c ? cloudinary.url(publicId, { secure: true, cloud_name: c.cloudName }) : null;
}

/** 503 when Cloudinary env is missing (dev/test). Not an HttpError code, so built here. */
export function uploadsNotConfigured() {
  return Response.json(
    { error: { code: "uploads_not_configured", message: "Photo uploads are not configured" } },
    { status: 503 },
  );
}
