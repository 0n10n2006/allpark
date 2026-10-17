import { describe, expect, it, vi, afterEach } from "vitest";
import { parseEnv } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  AUTH_URL: "https://parkshare.example.in",
  EMAIL_FROM: "ParkShare <noreply@parkshare.example.in>",
  AUTH_SECRET: "a".repeat(64),
  CRON_SECRET: "b".repeat(64),
};

describe("demo mode principle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isDemoMode is false in production even with DEMO_MODE=1", () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(isDemoMode()).toBe(false);
  });

  it("isDemoMode is false when DEMO_MODE is not 1", () => {
    vi.stubEnv("DEMO_MODE", "0");
    vi.stubEnv("NODE_ENV", "development");
    expect(isDemoMode()).toBe(false);

    vi.stubEnv("DEMO_MODE", "");
    expect(isDemoMode()).toBe(false);
  });

  it("isDemoMode is true when DEMO_MODE=1 and NODE_ENV is development", () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "development");
    expect(isDemoMode()).toBe(true);
  });

  it("env validation throws at boot if DEMO_MODE=1 in production", () => {
    expect(() =>
      parseEnv({
        ...base,
        DEMO_MODE: "1",
        NODE_ENV: "production",
      }),
    ).toThrow(/DEMO_MODE cannot be enabled in production/);
  });

  it("env validation allows DEMO_MODE=1 in development or test", () => {
    expect(() =>
      parseEnv({
        ...base,
        DEMO_MODE: "1",
        NODE_ENV: "development",
      }),
    ).not.toThrow();

    expect(() =>
      parseEnv({
        ...base,
        DEMO_MODE: "1",
        NODE_ENV: "test",
      }),
    ).not.toThrow();
  });
});
