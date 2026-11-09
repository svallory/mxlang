import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares workers).
    // Without it: index.test.ts "mx() custom tag discovery warns once about a
    // misconfigured mx.tags" expects 1 warning, got 0 (cached tag discovery).
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
