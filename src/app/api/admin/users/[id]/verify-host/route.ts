import { AdminVerifyHostBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../../../../_lib/not-implemented";

// Stub (T2.0). Implemented by T4.6.
export const POST = route(
  { auth: "admin", params: IdParams, body: AdminVerifyHostBody },
  notImplemented,
);
