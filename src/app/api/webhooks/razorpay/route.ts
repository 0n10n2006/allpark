import { RazorpayWebhookBody } from "@/contracts";
import { log } from "@/server/payments/log";
import { getPaymentProvider, notConfigured } from "@/server/payments/provider";
import { processWebhookEvent } from "@/server/payments/service";

// No route() wrapper: there is no user and no Origin; the HMAC of the RAW body against
// RAZORPAY_WEBHOOK_SECRET is the authentication. Nothing is stored for a bad signature.
const bad = (message: string) =>
  Response.json({ error: { code: "validation_error", message } }, { status: 400 });

export async function POST(req: Request) {
  const provider = getPaymentProvider();
  if (!provider) return notConfigured();
  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  if (!provider.verifyWebhookSignature(raw, signature)) {
    log("warn", "webhook.bad_signature", { bytes: raw.length });
    return bad("Invalid signature");
  }
  const eventId = req.headers.get("x-razorpay-event-id");
  let parsed;
  try {
    parsed = RazorpayWebhookBody.safeParse(JSON.parse(raw));
  } catch {
    parsed = null;
  }
  if (!eventId || eventId.length > 200 || !parsed?.success) {
    log("warn", "webhook.malformed", { hasEventId: Boolean(eventId) });
    return bad("Malformed webhook");
  }
  try {
    await processWebhookEvent(eventId, parsed.data);
  } catch (e) {
    // 5xx makes Razorpay retry; the event wasn't recorded because its transaction rolled back.
    log("error", "webhook.error", { eventId, event: parsed.data.event, error: (e as Error).name });
    return Response.json(
      { error: { code: "internal_error", message: "Internal server error" } },
      { status: 500 },
    );
  }
  return Response.json({ received: true });
}
