import { CheckInBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../../../_lib/not-implemented";

// Stub (T2.0). Implemented by T4.2.
export const POST = route({ auth: "user", params: IdParams, body: CheckInBody }, notImplemented);
