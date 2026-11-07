import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// `preact` declares `preact-render-to-string` as an optional peer, so bun can
// install two store entries of the same preact version: one linked beside
// `preact-render-to-string` and one beside the workspace. On a clean install
// `preact-render-to-string` then loads its own copy, and the copy the tests
// render with (hooks, options, vnodes) is a different module instance, so
// hooks fail with `reading '__H'` and the server renderer misses the boundary.
// Pin every `preact` specifier, including the ones inside the inlined
// `preact-render-to-string`, to the workspace's copy.
const requireFromHere = createRequire(import.meta.url);

export default defineConfig({
  plugins: [
    {
      name: "mx-single-preact",
      enforce: "pre",
      resolveId(id) {
        if (id !== "preact" && !id.startsWith("preact/")) return null;
        try {
          return requireFromHere.resolve(id);
        } catch {
          return null;
        }
      },
    },
  ],
  test: {
    // Only the independent strict-tsc cases opt into concurrency. Their shared
    // cross-worker checker pool is capped at 2, not 2 per test file.
    globalSetup: ["./src/fixtures/strict-tsc-setup.ts"],
    maxConcurrency: 2,
    testTimeout: 30_000,
    server: { deps: { inline: ["preact-render-to-string"] } },
  },
});
