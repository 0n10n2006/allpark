import { defineConfig, devices } from "@playwright/test";

try {
  process.loadEnvFile();
} catch {}

// Each worktree gets its own port (E2E_PORT, written by setup:worktree), so a reused
// dev server is always this checkout's, never another worktree's server and database.
// localhost (not 127.0.0.1): it matches AUTH_URL for the Origin check, and dev HMR works.
const port = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  // First request compiles the route in dev mode (slow on Windows); one retry absorbs it.
  retries: 1,
  timeout: 60_000,
  use: { baseURL },
  webServer: {
    command: `npm run dev -- -p ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000, // cold dev boot is slow on Windows while other worktrees build
    // Cloudinary values are obviously fake: signing is local and e2e route-mocks uploads.
    env: {
      ...process.env,
      AUTH_URL: baseURL,
      CLOUDINARY_CLOUD_NAME: "e2e-test",
      CLOUDINARY_API_KEY: "000000",
      CLOUDINARY_API_SECRET: "e2e-not-a-secret",
      // Razorpay too: e2e/checkout-pay.spec.ts serves a fake Razorpay API on port + 1000 (outside the
      // 3100-3899 worktree range) and
      // route-mocks checkout.js; signatures use this fake secret.
      RAZORPAY_KEY_ID: "rzp_test_e2e_fake",
      RAZORPAY_KEY_SECRET: "e2e-razorpay-key-secret-not-real",
      RAZORPAY_WEBHOOK_SECRET: "e2e-razorpay-webhook-secret-not-real",
      RAZORPAY_API_URL: `http://127.0.0.1:${port + 1000}`,
      // The only non-test mode that honours RAZORPAY_API_URL (src/server/payments/provider.ts).
      E2E: "1",
    } as Record<string, string>,
  },
  projects: [
    // Compiles every route once before the specs hit them in parallel (e2e/warmup.setup.ts).
    { name: "warmup", testMatch: /warmup\.setup\.ts/ },
    {
      name: "mobile",
      dependencies: ["warmup"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: "desktop", dependencies: ["warmup"], use: { ...devices["Desktop Chrome"] } },
  ],
});
