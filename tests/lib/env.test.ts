import { expect, test } from "vitest";
import { parseEnv } from "@/lib/env";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  AUTH_URL: "https://parkshare.example.in",
  EMAIL_FROM: "ParkShare <noreply@parkshare.example.in>",
  AUTH_SECRET: "a".repeat(64),
  CRON_SECRET: "b".repeat(64),
};

test("production rejects placeholder and short secrets; dev accepts them (L5)", () => {
  expect(() => parseEnv({ ...base, NODE_ENV: "production" })).not.toThrow();
  expect(() => parseEnv({ ...base, NODE_ENV: "production", CRON_SECRET: "replace-me" })).toThrow(
    /CRON_SECRET/,
  );
  expect(() =>
    parseEnv({ ...base, NODE_ENV: "production", RAZORPAY_KEY_SECRET: "changeme-please" }),
  ).toThrow(/RAZORPAY_KEY_SECRET/);
  expect(() => parseEnv({ ...base, NODE_ENV: "production", AUTH_SECRET: "short" })).toThrow(
    /AUTH_SECRET/,
  );
  expect(() =>
    parseEnv({ ...base, NODE_ENV: "development", CRON_SECRET: "replace-me" }),
  ).not.toThrow();
});
