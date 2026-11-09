import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Needs per-file process isolation (cached consumers bypass hoisted mocks
    // and shared emitter/reader state when files share a worker).
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
