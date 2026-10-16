import { expect, test } from "vitest";
import nextConfig from "../../next.config";

test("every route sends the security headers (L4)", async () => {
  const [rule] = await nextConfig.headers!();
  expect(rule.source).toBe("/:path*");
  const h = Object.fromEntries(rule.headers.map((x) => [x.key, x.value]));
  expect(h).toMatchObject({
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  expect(h["Permissions-Policy"]).toContain("geolocation=(self)");
  const csp = h["Content-Security-Policy"];
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toMatch(/script-src [^;]*https:\/\/checkout\.razorpay\.com/);
  expect(csp).toMatch(/img-src [^;]*https:\/\/res\.cloudinary\.com/);
  expect(csp).toMatch(/connect-src [^;]*https:\/\/\*\.mapbox\.com/);
});
