import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Needs per-file process isolation (hoisted mocks and shared reader state
    // break when files share a worker).
    poolOptions: { forks: { isolate: true } },
  },
});
