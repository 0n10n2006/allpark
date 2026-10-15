import { afterEach, expect, test, vi } from "vitest";
import { getPaymentProvider, setPaymentProvider } from "@/server/payments/provider";
import { setEmailSender } from "@/server/notifications/email";

afterEach(() => vi.unstubAllEnvs());

const baseUrl = () =>
  (getPaymentProvider() as unknown as { rz: { api: { rq: { defaults: { baseURL: string } } } } }).rz
    .api.rq.defaults.baseURL;

test("RAZORPAY_API_URL is honoured only under test or explicit dev e2e (L2)", () => {
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_x");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "s");
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "w");
  vi.stubEnv("RAZORPAY_API_URL", "http://127.0.0.1:9");
  expect(baseUrl()).toBe("http://127.0.0.1:9");
  for (const [env, e2e] of [
    ["", ""],
    ["staging", ""],
    ["development", ""],
    ["production", "1"],
  ]) {
    vi.stubEnv("NODE_ENV", env);
    vi.stubEnv("E2E", e2e);
    expect(baseUrl(), `${env}/${e2e}`).not.toBe("http://127.0.0.1:9");
  }
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("E2E", "1");
  expect(baseUrl()).toBe("http://127.0.0.1:9");
});

test("provider and email overrides refuse to install outside NODE_ENV=test (L2)", () => {
  vi.stubEnv("NODE_ENV", "development");
  expect(() => setPaymentProvider(null)).toThrow(/test-only/);
  expect(() => setEmailSender(null)).toThrow(/test-only/);
});
