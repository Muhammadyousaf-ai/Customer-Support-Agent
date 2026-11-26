import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second dev server (browser tests on another port) needs its own build directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Cache Components / Partial Prefetching (experimental PPR) are disabled: the workspace reader pages are
  // deeply client-interactive (IndexedDB + useSyncExternalStore stores for theme, margin style, workspace
  // mode, notifications), which those features refuse to statically prerender. The app uses no `"use cache"`
  // APIs, so standard rendering (server snapshot + client hydration) is the correct model here.
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
