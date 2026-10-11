import { CreateListingBody, SearchListingsQuery } from "@/contracts";
import { createListing } from "@/server/listings/service";
import { searchListings } from "@/server/search/service";
import { route } from "@/server/http/route";

export const GET = route(
  {
    auth: "public",
    query: SearchListingsQuery,
    rateLimit: { name: "search", limit: 120, windowSeconds: 60 },
  },
  async ({ query }) => Response.json(await searchListings(query)),
);
export const POST = route({ auth: "user", body: CreateListingBody }, async ({ user, body }) =>
  Response.json(await createListing(user, body), { status: 201 }),
);
