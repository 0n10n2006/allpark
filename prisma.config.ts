import { defineConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env; use Node's built-in loader.
try {
  process.loadEnvFile();
} catch {}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { seed: "node --env-file-if-exists=.env --import tsx prisma/seed.ts" },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/parkshare",
  },
});
