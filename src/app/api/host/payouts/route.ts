import { PaginationQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../../_lib/not-implemented";

// Stub (T2.0). Implemented by T4.5.
export const GET = route({ auth: "user", query: PaginationQuery }, notImplemented);
