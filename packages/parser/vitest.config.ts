import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Needs per-file process isolation (hoisted mocks/shared state break when
    // files share a worker).
    poolOptions: { forks: { isolate: true } },
    exclude: [
      "**/node_modules/**",
      // `node:test` suite; `src/template/upstream-suite.test.ts` runs it.
      "src/template/__tests__/**",
    ],
  },
});
