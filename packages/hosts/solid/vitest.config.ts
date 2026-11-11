import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares workers).
    // Still needed (re-checked under isolate:false, `--sequence.shuffle --sequence.seed=2`: 19 failures in ir-readonly.test.ts and ir-contract.test.ts): ir-readonly's hoisted core-lowering mock is bypassed by an
    // already-imported consumer when modules are shared across files.
    poolOptions: { forks: { isolate: true } },
    testTimeout: 30_000,
  },
});
