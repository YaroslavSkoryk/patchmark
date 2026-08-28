import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import nextWebpack from "next/dist/compiled/webpack/webpack.js";
import { loadBindings } from "next/dist/build/swc/index.js";
import terser from "next/dist/compiled/terser/bundle.min.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
export const optimizedHarnessOutput = join(repositoryRoot, ".hc3-slice5-optimized");

export async function buildOptimizedHarness() {
  rmSync(optimizedHarnessOutput, { recursive: true, force: true });
  mkdirSync(optimizedHarnessOutput, { recursive: true });
  await loadBindings();
  const webpack = nextWebpack.webpack;
  const compiler = webpack({
    mode: "production",
    target: ["web", "es2022"],
    context: repositoryRoot,
    entry: join(scriptDirectory, "collaboration-hc3-slice5-optimized-entry.tsx"),
    devtool: false,
    output: {
      path: optimizedHarnessOutput,
      filename: "optimized-harness.js",
      chunkFilename: "optimized-harness-[contenthash].js",
      publicPath: "/assets/",
      trustedTypes: "patchmark#optimized-bundler",
      clean: true
    },
    module: {
      rules: [
        {
          test: /\.module\.css$/,
          use: [join(scriptDirectory, "collaboration-hc3-slice5-optimized-css-loader.cjs")]
        },
        {
          test: /\.[cm]?[jt]sx?$/,
          exclude: /node_modules/,
          use: [{
            loader: "next/dist/build/webpack/loaders/next-swc-loader",
            options: {
              rootDir: repositoryRoot,
              isServer: false,
              hasReactRefresh: false,
              nextConfig: { experimental: {} },
              jsConfig: { compilerOptions: { jsx: "preserve" } },
              swcCacheDir: join(optimizedHarnessOutput, "swc-cache"),
              transpilePackages: []
            }
          }]
        }
      ]
    },
    resolve: {
      alias: { "@": repositoryRoot },
      extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
      mainFields: ["browser", "module", "main"],
      conditionNames: ["browser", "import", "module", "default"],
      fallback: { child_process: false, crypto: false, fs: false, path: false }
    },
    optimization: {
      minimize: false,
      splitChunks: false,
      runtimeChunk: false
    },
    plugins: [
      new webpack.DefinePlugin({
        "process.env.NODE_ENV": JSON.stringify("production")
      }),
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })
    ],
    performance: { hints: false },
    stats: "errors-warnings"
  });
  const stats = await new Promise((resolveBuild, rejectBuild) => {
    compiler.run((error, result) => {
      compiler.close(() => undefined);
      if (error) rejectBuild(error);
      else resolveBuild(result);
    });
  });
  if (!stats || stats.hasErrors()) {
    throw new Error(stats?.toString({ all: false, errors: true, errorDetails: true }) ?? "Optimized harness compilation failed.");
  }
  const javascript = join(optimizedHarnessOutput, "optimized-harness.js");
  const javascriptAssets = readdirSync(optimizedHarnessOutput)
    .filter((name) => name.endsWith(".js"))
    .sort();
  for (const asset of javascriptAssets) {
    const assetPath = join(optimizedHarnessOutput, asset);
    const optimized = await terser.minify(readFileSync(assetPath, "utf8"), {
      compress: true,
      ecma: 2022,
      format: { comments: false },
      mangle: true,
      module: false,
      sourceMap: false
    });
    if (!optimized.code) throw new Error(`Optimized harness minification produced no JavaScript for ${asset}.`);
    let output = optimized.code;
    if (asset === "optimized-harness.js") {
      const identityPolicy = /([A-Za-z_$][\w$]*)=\{createScriptURL:([A-Za-z_$][\w$]*)=>\2\}/;
      if (!identityPolicy.test(output)) throw new Error("Optimized harness did not contain the expected private Webpack Trusted Types rule.");
      output = output.replace(identityPolicy, (_match, policyVariable, valueVariable) =>
        `${policyVariable}={createScriptURL:${valueVariable}=>{${valueVariable}=new URL(${valueVariable},location.href);const p=${valueVariable}.protocol,h=${valueVariable}.hostname;if(${valueVariable}.origin!==location.origin||!(p==="https:"||p==="http:"&&/^(?:127\\.0\\.0\\.1|localhost|\\[::1\\])$/.test(h))||${valueVariable}.username||${valueVariable}.password||${valueVariable}.search||${valueVariable}.hash||!/^\\/assets\\/optimized-harness-[a-f0-9]{8,64}\\.js$/.test(${valueVariable}.pathname))throw new TypeError("Optimized bundler script URL is outside the fixed same-origin worker boundary.");return ${valueVariable}.href}}`
      );
      if (identityPolicy.test(output)) throw new Error("Optimized harness retained an identity Trusted Types rule.");
    }
    writeFileSync(assetPath, output);
  }
  copyFileSync(
    join(repositoryRoot, "components/collaboration/collaboration-qualification-workspace.module.css"),
    join(optimizedHarnessOutput, "optimized-harness.css")
  );
  return Object.freeze({
    output_directory: optimizedHarnessOutput,
    javascript,
    javascript_assets: Object.freeze(javascriptAssets),
    stylesheet: join(optimizedHarnessOutput, "optimized-harness.css")
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildOptimizedHarness();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
