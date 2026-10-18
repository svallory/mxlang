import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mxlang/stock-marko",
    // No global state (audited): reads env, writes nothing.
    isolate: false,
  },
});
