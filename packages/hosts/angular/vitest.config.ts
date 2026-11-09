import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Needs per-file process isolation (cached consumers bypass hoisted mocks
    // and shared emitter/reader state when files share a worker).
    pool: "threads",
    poolOptions: { threads: { isolate: true } },
    testTimeout: 30_000,
    // Yields between tests so a file of synchronous ngtsc tests cannot hold
    // the event loop for its whole run (#390).
    setupFiles: [
      fileURLToPath(
        new URL("../../../scripts/vitest-yield.ts", import.meta.url),
      ),
    ],
  },
});
