import { IdParams, PublishListingBody } from "@/contracts";
import { publishListing } from "@/server/listings/service";
import { route } from "@/server/http/route";

export const POST = route(
  { auth: "user", params: IdParams, body: PublishListingBody },
  async ({ req, user, params }) => Response.json(await publishListing(user, params.id, req)),
);
