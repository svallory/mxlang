import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares workers).
    // Without it: index.test.ts "Solid IR lowering dynamic tag (tagged)" expects
    // `__mxDyn0` but a shared emitter serial gives `__mxDyn135`; ir-readonly's
    // hoisted core-lowering mock is bypassed by an already-imported consumer.
    poolOptions: { forks: { isolate: true } },
    testTimeout: 30_000,
  },
});
