import { AdminListPhotosQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { adminListPhotos } from "@/server/admin/photos";

export const GET = route(
  { auth: "admin", query: AdminListPhotosQuery },
  async ({ query }) => {
    return Response.json(await adminListPhotos(query));
  },
);
