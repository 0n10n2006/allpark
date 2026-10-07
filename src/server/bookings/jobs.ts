import { z } from "zod";
import { expireStaleHolds, scheduleHoldSweep } from "@/server/availability/service";
import { registerJob } from "@/server/jobs/registry";

// Hold-expiry sweeper (FR-04 AC2): frees inventory even when nobody tries to book.
// Each run schedules the next minute first, so the chain survives a failing sweep;
// createHold also schedules one per hold, which bootstraps and repairs the chain.
// The type is a literal, not EXPIRE_HOLDS_JOB: this module is reached through an import
// cycle (availability -> jobs -> builtins -> here), so top-level imports may be uninitialized.
registerJob("bookings.expireHolds", z.object({}).passthrough(), async () => {
  await scheduleHoldSweep(new Date());
  await expireStaleHolds();
});
