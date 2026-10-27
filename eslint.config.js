import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.wrangler/**", "worker-configuration.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { console: "readonly", crypto: "readonly", btoa: "readonly", atob: "readonly" } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "no-warning-comments": "error",
    },
  },
  {
    files: ["**/scripts/*.mjs"],
    languageOptions: { globals: { process: "readonly", fetch: "readonly", URL: "readonly" } },
  },
);
