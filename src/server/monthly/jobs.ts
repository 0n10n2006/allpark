import { z } from "zod";
import { registerJob } from "@/server/jobs/registry";
import { handleMonthlyExpire, handleRenewalReminder } from "./service";

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
