import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the independent strict-tsc cases opt into concurrency. Their shared
    // cross-worker checker pool is capped at 2, not 2 per test file.
    globalSetup: ["./src/fixtures/strict-tsc-setup.ts"],
    maxConcurrency: 2,
    testTimeout: 30_000,
  },
});
