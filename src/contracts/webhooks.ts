import { z } from "zod";

/**
 * POST /api/webhooks/razorpay. Authenticated by HMAC of the raw body against the
 * `X-Razorpay-Signature` header (verified by the handler, not by this schema) and
 * deduplicated by the `X-Razorpay-Event-Id` header. Loose: Razorpay adds fields.
 */
export const RazorpayWebhookBody = z.looseObject({
  entity: z.literal("event"),
  account_id: z.string().optional(),
  event: z.string(),
  contains: z.array(z.string()).optional(),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.number().int(),
});
export type RazorpayWebhookBody = z.infer<typeof RazorpayWebhookBody>;

export const RazorpayWebhookResponse = z.object({ received: z.literal(true) });
export type RazorpayWebhookResponse = z.infer<typeof RazorpayWebhookResponse>;
