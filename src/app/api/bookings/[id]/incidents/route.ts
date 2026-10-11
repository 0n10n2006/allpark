import { IdParams, ReportIncidentBody } from "@/contracts";
import { route } from "@/server/http/route";
import { reportIncident } from "@/server/sessions/service";

export const POST = route(
  { auth: "user", params: IdParams, body: ReportIncidentBody },
  async ({ user, params, body }) =>
    Response.json(await reportIncident(user, params.id, body), { status: 201 }),
);
