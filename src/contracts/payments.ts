import { z } from "zod";
import { Money, Uuid } from "./common";

// FR-06. The order amount is the hold's trusted total; the client sends only ids.

/** POST /api/payments/order (Idempotency-Key) */
export const CreatePaymentOrderBody = z.strictObject({ bookingId: Uuid });
export type CreatePaymentOrderBody = z.infer<typeof CreatePaymentOrderBody>;

/** Everything Razorpay Checkout needs. `keyId` is the public key id, never the secret. */
export const CreatePaymentOrderResponse = z.object({
  bookingId: Uuid,
  provider: z.literal("razorpay"),
  orderId: z.string(),
  keyId: z.string(),
  amount: Money,
});
export type CreatePaymentOrderResponse = z.infer<typeof CreatePaymentOrderResponse>;

/**
 * POST /api/bookings/:id/confirm-payment (Idempotency-Key). Hands over the Checkout
 * success callback. The server verifies the signature and the provider status;
 * this callback alone never confirms a booking (FR-06 AC1).
 */
export const ConfirmPaymentBody = z.strictObject({
  razorpayOrderId: z.string().min(1).max(100),
  razorpayPaymentId: z.string().min(1).max(100),
  razorpaySignature: z.string().min(1).max(200),
});
export type ConfirmPaymentBody = z.infer<typeof ConfirmPaymentBody>;
