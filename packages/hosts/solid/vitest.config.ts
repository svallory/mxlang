import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Needs per-file process isolation (cached consumers bypass hoisted mocks
    // and shared emitter/reader state when files share a worker).
    poolOptions: { forks: { isolate: true } },
    testTimeout: 30_000,
  },
});
