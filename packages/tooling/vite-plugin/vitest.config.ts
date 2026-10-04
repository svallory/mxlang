import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
