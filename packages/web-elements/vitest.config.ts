import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No global state (audited): the element table is a frozen import.
    isolate: false,
    testTimeout: 30_000,
  },
});
