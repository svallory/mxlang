import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      // `node:test` suite; `src/template/upstream-suite.test.ts` runs it.
      "src/template/__tests__/**",
    ],
  },
});
