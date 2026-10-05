import { GetAvailabilityQuery, IdParams, UpdateAvailabilityBody } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../../../_lib/not-implemented";

// Stub (T2.0). Implemented by T2.3.
export const GET = route(
  { auth: "public", params: IdParams, query: GetAvailabilityQuery },
  notImplemented,
);
export const POST = route(
  { auth: "user", params: IdParams, body: UpdateAvailabilityBody },
  notImplemented,
);
