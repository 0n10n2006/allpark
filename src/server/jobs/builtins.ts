import { z } from "zod";
import { registerJob } from "./registry";

// A deliberately side-effect-free handler used to prove queue plumbing in tests.
registerJob("system.noop", z.object({}).passthrough(), async () => {});
