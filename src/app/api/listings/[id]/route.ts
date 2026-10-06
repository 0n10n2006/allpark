import { IdParams, UpdateListingBody } from "@/contracts";
import { getPublicListing, updateListing } from "@/server/listings/service";
import { route } from "@/server/http/route";

export const GET = route({ auth: "public", params: IdParams }, async ({ user, params }) =>
  Response.json(await getPublicListing(params.id, user)),
);
export const PATCH = route(
  { auth: "user", params: IdParams, body: UpdateListingBody },
  async ({ user, params, body }) => Response.json(await updateListing(user, params.id, body)),
);
