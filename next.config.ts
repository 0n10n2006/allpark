import type { NextConfig } from "next";

const prod = process.env.NODE_ENV === "production";

// L4. Static CSP (no nonces): Next's inline bootstrap needs 'unsafe-inline'; dev also needs
// eval. Razorpay checkout (script, iframe, API), Mapbox (tiles, static maps, blob workers),
// Cloudinary (images, direct uploads). HTTPS-only directives stay off in dev/e2e (http).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${prod ? "" : " 'unsafe-eval'"} https://checkout.razorpay.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://res.cloudinary.com https://api.mapbox.com https://*.razorpay.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.razorpay.com https://*.mapbox.com https://api.cloudinary.com",
  "frame-src https://*.razorpay.com",
  "worker-src 'self' blob:",
  "child-src blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(prod ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
  ...(prod
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // The dev-tools badge overlays the mobile bottom nav and steals clicks in e2e.
  devIndicators: false,
  // Dev HMR from 127.0.0.1 (some tools use it instead of localhost).
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
