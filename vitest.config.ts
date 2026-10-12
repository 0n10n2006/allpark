import { defineConfig } from "vitest/config";
import path from "node:path";

try {
  process.loadEnvFile();
} catch {}

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.dom.test.tsx"],
    globalSetup: ["tests/setup/global.ts"],
    // Code under test imports src/server/db.ts, which reads DATABASE_URL: point it at the test DB.
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" },
    // DB integration tests share one test database; run files serially.
    fileParallelism: false,
    // Mostly DB integration tests; 5s defaults flake while other worktrees build.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
