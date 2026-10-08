import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://127.0.0.1:3000" },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    // Obviously fake: signing and delivery URLs are computed locally; e2e route-mocks Cloudinary.
    env: {
      ...process.env,
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
