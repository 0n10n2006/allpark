import { CancelBookingBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../../../_lib/not-implemented";

// Stub (T2.0). Implemented by T2.1, T4.4.
export const POST = route(
  { auth: "user", params: IdParams, body: CancelBookingBody },
  notImplemented,
);
