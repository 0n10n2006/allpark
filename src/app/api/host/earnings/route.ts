import { HostEarningsQuery } from "@/contracts";
import { HttpError } from "@/server/http/errors";
import { route } from "@/server/http/route";
import { hostEarningsSummary } from "@/server/payouts/earnings";

export const GET = route({ auth: "user", query: HostEarningsQuery }, async ({ user, query }) => {
  if (!user.roles.includes("HOST")) throw new HttpError("forbidden", "Host account required");
  return Response.json(await hostEarningsSummary(user.id, query));
});
