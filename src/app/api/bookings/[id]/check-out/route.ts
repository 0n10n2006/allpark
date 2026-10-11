import { CheckOutBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { checkOut } from "@/server/sessions/service";

export const POST = route(
  { auth: "user", params: IdParams, body: CheckOutBody },
  async ({ user, params, body }) => Response.json(await checkOut(user, params.id, body)),
);
