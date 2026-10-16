import { AdminModeratePhotoBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { adminModeratePhoto } from "@/server/admin/photos";

export const POST = route(
  { auth: "admin", params: IdParams, body: AdminModeratePhotoBody },
  async ({ user, params, body }) => {
    return Response.json(await adminModeratePhoto(user, params.id, body));
  },
);
