import { CreateBookingBody, ListBookingsQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { notImplemented } from "../_lib/not-implemented";

// Stub (T2.0). Implemented by T2.1.
export const GET = route({ auth: "user", query: ListBookingsQuery }, notImplemented);
export const POST = route({ auth: "user", body: CreateBookingBody }, notImplemented);
