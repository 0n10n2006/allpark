import { GetAvailabilityQuery, IdParams, UpdateAvailabilityBody } from "@/contracts";
import { replaceAvailability } from "@/server/listings/service";
import { route } from "@/server/http/route";
import { notImplemented } from "../../../_lib/not-implemented";

// GET: stub (T2.0), implemented by T2.1.
export const GET = route(
  { auth: "public", params: IdParams, query: GetAvailabilityQuery },
  notImplemented,
);
export const POST = route(
  { auth: "user", params: IdParams, body: UpdateAvailabilityBody },
  async ({ user, params, body }) =>
    Response.json(await replaceAvailability(user, params.id, body.rules, body.exceptions)),
);
