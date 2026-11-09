import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares workers).
    // Without it: frontend/stand-in-checks.test.ts "the reparse does not run
    // for an error in a container with no triggers" expects 1 call, got 0 (a
    // hoisted mock bypassed by an already-imported module).
    poolOptions: { forks: { isolate: true } },
    exclude: [
      "**/node_modules/**",
      // `node:test` suite; `src/template/upstream-suite.test.ts` runs it.
      "src/template/__tests__/**",
    ],
  },
});
