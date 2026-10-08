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
  use: { baseURL },
  webServer: {
    command: `npm run dev -- -p ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    env: { ...process.env, AUTH_URL: baseURL } as Record<string, string>,
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
