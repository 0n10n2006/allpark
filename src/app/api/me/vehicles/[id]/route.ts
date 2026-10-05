import { IdParams, UpdateVehicleBody } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../../../_lib/not-implemented";

// Stub (T2.0). Implemented by T2.5.
export const PATCH = route(
  { auth: "user", params: IdParams, body: UpdateVehicleBody },
  notImplemented,
);
export const DELETE = route({ auth: "user", params: IdParams }, notImplemented);
