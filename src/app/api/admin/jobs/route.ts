import { AdminListJobsQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../../_lib/not-implemented";

// Stub (T2.0). Implemented by T4.6.
export const GET = route({ auth: "admin", query: AdminListJobsQuery }, notImplemented);
