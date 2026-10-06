import {
  AddListingPhotoBody,
  DeleteListingPhotoQuery,
  IdParams,
  ReorderListingPhotosBody,
} from "@/contracts";
import { addPhoto, deletePhoto, reorderPhotos } from "@/server/listings/service";
import { route } from "@/server/http/route";
import { uploadsNotConfigured } from "@/server/listings/cloudinary";

export const POST = route(
  { auth: "user", params: IdParams, body: AddListingPhotoBody },
  async ({ user, params, body }) => {
    const photo = await addPhoto(user, params.id, body.publicId, body.position);
    return photo ? Response.json(photo, { status: 201 }) : uploadsNotConfigured();
  },
);
export const PATCH = route(
  { auth: "user", params: IdParams, body: ReorderListingPhotosBody },
  async ({ user, params, body }) =>
    Response.json(await reorderPhotos(user, params.id, body.photoIds)),
);
export const DELETE = route(
  { auth: "user", params: IdParams, query: DeleteListingPhotoQuery },
  async ({ user, params, query }) =>
    Response.json(await deletePhoto(user, params.id, query.photoId)),
);
