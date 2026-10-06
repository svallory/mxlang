import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
