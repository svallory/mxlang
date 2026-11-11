import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares workers).
    // Still needed: scan-error-dedupe-unit.test.ts and
    // target-select-scan-error.test.ts `vi.mock("@mxlang/targets")`, and index.ts
    // keeps the registry in a module-level cached import, so without a reset the
    // first file's registry (mocked or not) serves every later file and their
    // mocked `scanCached` never runs. The scan cache itself no longer needs it:
    // index.test.ts "warns once about a misconfigured mx.tags" passes under
    // isolate: false, shuffled with seed 2.
    poolOptions: { forks: { isolate: true } },
    name: "@mxlang/vite-plugin",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        // Native descriptor requires and plugin imports must share callee
        // readers and caches, just like the published tool (PR 5 precedent).
        external: [/packages\/core\/dist\//],
      },
    },
  },
});
