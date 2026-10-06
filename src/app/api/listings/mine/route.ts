import { PaginationQuery } from "@/contracts";
import { listMine } from "@/server/listings/service";
import { route } from "@/server/http/route";

export const GET = route({ auth: "user", query: PaginationQuery }, async ({ user, query }) =>
  Response.json(await listMine(user, query.limit, query.cursor)),
);
