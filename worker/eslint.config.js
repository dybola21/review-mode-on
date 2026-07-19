import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        URL: "readonly",
        Response: "readonly",
        Request: "readonly",
        BodyInit: "readonly",
        NodeJS: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
