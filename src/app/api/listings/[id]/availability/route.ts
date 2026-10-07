import { GetAvailabilityQuery, IdParams, UpdateAvailabilityBody } from "@/contracts";
import { getListingAvailability } from "@/server/availability/service";
import { replaceAvailability } from "@/server/listings/service";
import { route } from "@/server/http/route";

export const GET = route(
  { auth: "public", params: IdParams, query: GetAvailabilityQuery },
  async ({ user, params, query }) =>
    Response.json(await getListingAvailability(params.id, user, query)),
);
export const POST = route(
  { auth: "user", params: IdParams, body: UpdateAvailabilityBody },
  async ({ user, params, body }) =>
    Response.json(await replaceAvailability(user, params.id, body.rules, body.exceptions)),
);
