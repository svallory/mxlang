import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares workers).
    // Without it: diagnose.test.ts "target-table dispatch uses the registered
    // region compiler for an untitled language id" fails with expected
    // "compileRegion" to be called at least once (hoisted mock bypassed).
    poolOptions: { forks: { isolate: true } },
  },
});
