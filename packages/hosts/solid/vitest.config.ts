import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares workers).
    // Still needed: ir-readonly's hoisted core-lowering mock is bypassed by an
    // already-imported consumer when modules are shared across files.
    poolOptions: { forks: { isolate: true } },
    testTimeout: 30_000,
  },
});
