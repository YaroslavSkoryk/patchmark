import type { NextConfig } from "next";

import { productReleaseState } from "./lib/release/product-release-state.ts";

const nextConfig: NextConfig = {
  webpack(config, { dev, webpack }) {
    if (dev && process.env.PATCHMARK_HC3_STRICT_POLICY_QUALIFICATION === "1") {
      // The development bundler normally uses eval-backed source maps. The
      // isolated Slice 5 qualification profile disables them so the actual
      // editor can be exercised without adding unsafe-eval to its CSP.
      config.devtool = false;
    }
    if (!dev) {
      config.plugins.push(new webpack.IgnorePlugin({
        checkResource(resource: string, context: string) {
          if (!context.replaceAll("\\", "/").endsWith("/lib/collaboration-shadow")) {
            return false;
          }
          if (resource === "./shadow-implementation.ts") return true;
          return (
            !productReleaseState.human_collaboration &&
            resource === "./product-qualification-loader.ts"
          );
        }
      }));
    }
    return config;
  }
};

export default nextConfig;
