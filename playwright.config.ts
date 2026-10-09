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
    // Cloudinary values are obviously fake: signing is local and e2e route-mocks uploads.
    env: {
      ...process.env,
      AUTH_URL: baseURL,
      CLOUDINARY_CLOUD_NAME: "e2e-test",
      CLOUDINARY_API_KEY: "000000",
      CLOUDINARY_API_SECRET: "e2e-not-a-secret",
    } as Record<string, string>,
  },
  projects: [
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
