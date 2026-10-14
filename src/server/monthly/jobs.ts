import { z } from "zod";
import { registerJob } from "@/server/jobs/registry";
import { handleCloseTerm, handleMonthlyExpire, handleRenewalReminder } from "./service";

const AgreementJobPayload = z.object({
  agreementId: z.string().uuid(),
  termEndAt: z.string(),
});

registerJob("monthly.renewalReminder", AgreementJobPayload, async ({ agreementId, termEndAt }) => {
  await handleRenewalReminder(agreementId, termEndAt);
});

registerJob("monthly.expire", AgreementJobPayload, async ({ agreementId, termEndAt }) => {
  await handleMonthlyExpire(agreementId, termEndAt);
});

// Literal type, not CLOSE_TERM_JOB: this module is reached through the jobs import cycle.
registerJob("monthly.closeTerm", z.object({ bookingId: z.uuid() }), ({ bookingId }) =>
  handleCloseTerm(bookingId),
);
