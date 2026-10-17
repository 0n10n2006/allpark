import { z } from "zod";

const optionalProvider = z.string().optional().default("");
const schema = z.object({
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(1),
  AUTH_URL: z.string().url(),
  EMAIL_FROM: z.string().min(1),
  RESEND_API_KEY: optionalProvider,
  RAZORPAY_KEY_ID: optionalProvider,
  RAZORPAY_KEY_SECRET: optionalProvider,
  RAZORPAY_WEBHOOK_SECRET: optionalProvider,
  NEXT_PUBLIC_RAZORPAY_KEY_ID: optionalProvider,
  CLOUDINARY_CLOUD_NAME: optionalProvider,
  CLOUDINARY_API_KEY: optionalProvider,
  CLOUDINARY_API_SECRET: optionalProvider,
  NEXT_PUBLIC_MAPBOX_TOKEN: optionalProvider,
  CRON_SECRET: z.string().min(1),
  APP_TIMEZONE: z.string().default("Asia/Kolkata"),
  DEMO_MODE: optionalProvider,
});

const PLACEHOLDER = /placeholder|changeme|change-me|replace-me|xxx/i;

/**
 * L5: in production, reject template values (e.g. .env.example's "replace-me") and short
 * secrets, so a copied example config fails at boot instead of accepting `Bearer replace-me`.
 */
export function parseEnv(source: NodeJS.ProcessEnv) {
  const env = schema.parse(source);
  if (source.DEMO_MODE === "1" && source.NODE_ENV === "production") {
    throw new Error("DEMO_MODE cannot be enabled in production");
  }
  if (source.NODE_ENV !== "production") return env;
  const bad = Object.entries(env)
    .filter(([, v]) => typeof v === "string" && PLACEHOLDER.test(v))
    .map(([k]) => k);
  for (const k of ["AUTH_SECRET", "CRON_SECRET"] as const)
    if (env[k].length < 32) bad.push(`${k} (under 32 characters)`);
  if (bad.length) throw new Error(`Invalid production env: ${bad.join(", ")}`);
  return env;
}

export const env = parseEnv(process.env);
