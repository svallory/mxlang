import { defineConfig } from "vitest/config";
import { singlePreact } from "./src/fixtures/single-preact-plugin.ts";

export default defineConfig({
  plugins: [singlePreact()],
  test: {
    name: "@mxlang/host-preact",
    // Only the independent strict-tsc cases opt into concurrency. Their shared
    // cross-worker checker pool is capped at 2, not 2 per test file.
    globalSetup: ["./src/fixtures/strict-tsc-setup.ts"],
    maxConcurrency: 2,
    testTimeout: 30_000,
    // Inlined so its own `preact` imports go through singlePreact().
    server: { deps: { inline: ["preact-render-to-string"] } },
  },
});
