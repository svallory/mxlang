import { defineConfig } from "vitest/config";

// The e2e suite drives a real Chromium and a real Vite server, so it lives
// behind the example's own `bun run e2e` rather than in the root `vitest run`
// (whose `projects` glob covers `packages/*` only).
export default defineConfig({
  test: {
    // Relative to the project root (the example directory), not to this file.
    // `resolve.spec.ts` is excluded on purpose: its assertions pass but its
    // teardown hangs (see that file's header), so it is run on demand rather
    // than stalling `bun run e2e` for two minutes.
    include: [
      "e2e/counter.spec.ts",
      "e2e/hmr.spec.ts",
      "e2e/whole-file.spec.ts",
    ],
    // Dev server start, browser launch, build and preview all happen inside
    // these tests; the default 5s timeout is far too short.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
