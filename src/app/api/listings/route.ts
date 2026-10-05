import { CreateListingBody, SearchListingsQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../_lib/not-implemented";

// Stub (T2.0). Implemented by T2.4, T2.3.
export const GET = route({ auth: "public", query: SearchListingsQuery }, notImplemented);
export const POST = route({ auth: "user", body: CreateListingBody }, notImplemented);
