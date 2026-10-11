import { CheckInBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { checkIn } from "@/server/sessions/service";

export const POST = route(
  { auth: "user", params: IdParams, body: CheckInBody },
  async ({ user, params, body }) => Response.json(await checkIn(user, params.id, body)),
);
