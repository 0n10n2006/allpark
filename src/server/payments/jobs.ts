import { z } from "zod";
import { registerJob } from "@/server/jobs/registry";
import { processRefund } from "./refunds";
import { reconcilePayments, scheduleReconcile } from "./service";

// Literal types, not the exported constants: this module is reached through the
// jobs -> builtins import cycle (see src/server/bookings/jobs.ts).
registerJob("payments.processRefund", z.object({ refundId: z.uuid() }), ({ refundId }) =>
  processRefund(refundId),
);
// Daily; each run schedules the next first so the chain survives a failing run.
registerJob("payments.reconcile", z.object({}).passthrough(), async () => {
  await scheduleReconcile(new Date());
  await reconcilePayments();
});
