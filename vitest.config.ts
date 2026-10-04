import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.dom.test.tsx"],
    globalSetup: ["tests/setup/global.ts"],
    // DB integration tests share one test database; run files serially.
    fileParallelism: false,
  },
});
