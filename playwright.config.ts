import { defineConfig, devices } from "@playwright/test";
export default defineConfig({ webServer: { command: "npm run dev", url: "http://127.0.0.1:3000", reuseExistingServer: !process.env.CI }, projects: [{ name: "mobile", use: { ...devices["iPhone 13"] } }, { name: "desktop", use: { ...devices["Desktop Chrome"] } }] });
