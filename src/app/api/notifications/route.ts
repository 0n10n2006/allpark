import { PaginationQuery, Uuid } from "@/contracts";
import { HttpError } from "@/server/http/errors";
import { route } from "@/server/http/route";
import { listInbox } from "@/server/notifications";

export const GET = route({ auth: "user", query: PaginationQuery }, async ({ user, query }) => {
  if (query.cursor && !Uuid.safeParse(query.cursor).success)
    throw new HttpError("validation_error", "Invalid cursor");
  return Response.json(await listInbox(user.id, query));
});
