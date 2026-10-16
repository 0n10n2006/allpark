import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));
vi.stubEnv("RESEND_API_KEY", "");
const { authConfig } = await import("@/server/auth/config");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

// The options Auth.js merges over the provider: what it actually calls to send a link.
const send = authConfig.providers[0].options!.sendVerificationRequest!;
const link = (identifier: string, ip: string) =>
  send({
    identifier,
    url: "http://localhost/api/auth/callback/resend?token=t",
    token: "t",
    expires: new Date(),
    provider: authConfig.providers[0] as never,
    theme: {},
    request: new Request("http://localhost/api/auth/signin/resend", {
      headers: { "x-forwarded-for": `${ip}, 10.0.0.1`, "x-real-ip": ip },
    }),
  });

test("magic links are capped per email and per IP; over the cap nothing is sent (M2)", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const sent = () =>
    log.mock.calls.filter((c) => String(c[0]).includes("magic sign-in link")).length;
  for (let i = 0; i < 6; i++) await link("victim@example.com", `198.51.100.${i}`);
  expect(sent()).toBe(5);
  for (let i = 0; i < 21; i++) await link(`u${i}@example.com`, "203.0.113.7");
  expect(sent()).toBe(5 + 20);
  log.mockRestore();
});
