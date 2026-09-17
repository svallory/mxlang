import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@mxlang/angular-checker",
    // Each check builds a real NgtscProgram; the spike measured cold runs from
    // 648ms to 8.4s depending on machine load, so the default 5s timeout is
    // not enough under contention.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
