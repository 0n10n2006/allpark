import { PaginationQuery } from "@/contracts";
import { HttpError } from "@/server/http/errors";
import { route } from "@/server/http/route";
import { listHostPayouts } from "@/server/payouts/service";

export const GET = route({ auth: "user", query: PaginationQuery }, async ({ user, query }) => {
  if (!user.roles.includes("HOST")) throw new HttpError("forbidden", "Host account required");
  return Response.json(await listHostPayouts(user.id, query));
});
