import { IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { markRead } from "@/server/notifications";

export const POST = route({ auth: "user", params: IdParams }, async ({ user, params }) => {
  await markRead(user.id, params.id);
  return Response.json({ ok: true });
});
