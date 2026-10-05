import { CreateQuoteBody } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../_lib/not-implemented";

// Stub (T2.0). Implemented by T2.2.
export const POST = route({ auth: "user", body: CreateQuoteBody }, notImplemented);
