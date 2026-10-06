import { CreateListingBody, SearchListingsQuery } from "@/contracts";
import { createListing } from "@/server/listings/service";
import { route } from "@/server/http/route";
import { notImplemented } from "../_lib/not-implemented";

// Stub (T2.0). Implemented by T2.4.
export const GET = route({ auth: "public", query: SearchListingsQuery }, notImplemented);
export const POST = route({ auth: "user", body: CreateListingBody }, async ({ user, body }) =>
  Response.json(await createListing(user, body), { status: 201 }),
);
