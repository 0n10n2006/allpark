import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
