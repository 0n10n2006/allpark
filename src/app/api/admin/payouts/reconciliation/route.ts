import { route } from "@/server/http/route";
import { payoutReconciliation } from "@/server/payouts/service";

export const GET = route({ auth: "admin" }, async () =>
  Response.json(await payoutReconciliation()),
);
