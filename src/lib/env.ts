import { z } from "zod";

const optionalProvider = z.string().optional().default("");
const schema = z.object({
  DATABASE_URL: z.string().url(), TEST_DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(1), AUTH_URL: z.string().url(), EMAIL_FROM: z.string().min(1),
  RESEND_API_KEY: optionalProvider, RAZORPAY_KEY_ID: optionalProvider, RAZORPAY_KEY_SECRET: optionalProvider,
  RAZORPAY_WEBHOOK_SECRET: optionalProvider, NEXT_PUBLIC_RAZORPAY_KEY_ID: optionalProvider,
  CLOUDINARY_CLOUD_NAME: optionalProvider, CLOUDINARY_API_KEY: optionalProvider, CLOUDINARY_API_SECRET: optionalProvider,
  NEXT_PUBLIC_MAPBOX_TOKEN: optionalProvider, CRON_SECRET: z.string().min(1), APP_TIMEZONE: z.string().default("Asia/Kolkata"),
});

export const env = schema.parse(process.env);
