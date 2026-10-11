import { z } from "zod";
import { registerJob } from "./registry";
import "@/server/bookings/jobs";
import "@/server/notifications/jobs";
import "@/server/payments/jobs";
import "@/server/monthly/jobs";

// A deliberately side-effect-free handler used to prove queue plumbing in tests.
registerJob("system.noop", z.object({}).passthrough(), async () => {});
