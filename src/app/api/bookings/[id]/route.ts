import { IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../../_lib/not-implemented";

// Stub (T2.0). Implemented by T2.1.
export const GET = route({ auth: "user", params: IdParams }, notImplemented);
