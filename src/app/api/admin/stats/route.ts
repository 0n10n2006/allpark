import { route } from "@/server/http/route";
import { adminGetStats } from "@/server/admin/service";

export const GET = route({ auth: "admin" }, async () => {
  return Response.json(await adminGetStats());
});
