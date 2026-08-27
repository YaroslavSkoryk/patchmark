import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack(config, { dev }) {
    if (dev && process.env.PATCHMARK_HC3_STRICT_POLICY_QUALIFICATION === "1") {
      // The development bundler normally uses eval-backed source maps. The
      // isolated Slice 5 qualification profile disables them so the actual
      // editor can be exercised without adding unsafe-eval to its CSP.
      config.devtool = false;
    }
    return config;
  }
};

export default nextConfig;
