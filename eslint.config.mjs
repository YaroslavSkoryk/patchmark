import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    // Next 16's React Hooks 7 flat preset newly enables compiler-oriented
    // rules that were not part of Patchmark's accepted lint contract. Their
    // findings span existing state/ref architecture and require a separate,
    // behavior-qualified refactor rather than a dependency-security migration.
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off"
    }
  },
  globalIgnores([".next/**", "node_modules/**", "next-env.d.ts"])
]);

export default eslintConfig;
