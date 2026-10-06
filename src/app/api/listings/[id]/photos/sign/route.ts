import { IdParams, SignPhotoUploadBody } from "@/contracts";
import { signUpload, uploadsNotConfigured } from "@/server/listings/cloudinary";
import { assertListingOwner } from "@/server/listings/service";
import { route } from "@/server/http/route";

export const POST = route(
  {
    auth: "user",
    params: IdParams,
    body: SignPhotoUploadBody,
    rateLimit: { name: "photo-sign", limit: 60, windowSeconds: 3600 },
  },
  async ({ user, params }) => {
    await assertListingOwner(user, params.id);
    const signed = signUpload(params.id);
    return signed ? Response.json(signed) : uploadsNotConfigured();
  },
);
