import { IdParams, SignPhotoUploadBody } from "@/contracts";
import { route } from "@/server/http/route";
import { uploadsNotConfigured } from "@/server/listings/cloudinary";
import { signEvidenceUpload } from "@/server/media/evidence";

export const POST = route(
  {
    auth: "user",
    params: IdParams,
    body: SignPhotoUploadBody,
    rateLimit: { name: "evidence-sign", limit: 60, windowSeconds: 3600 },
  },
  async ({ user, params }) => {
    const signed = await signEvidenceUpload(user, params.id);
    return signed ? Response.json(signed) : uploadsNotConfigured();
  },
);
