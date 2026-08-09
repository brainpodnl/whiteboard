import type { NextConfig } from "next";

/**
 * No `output: 'standalone'`. Standalone mode does not trace custom server files
 * and cannot be combined with one — the container runs dist/server/index.js
 * against real node_modules instead.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "ioredis", "ws"],
};

export default nextConfig;
