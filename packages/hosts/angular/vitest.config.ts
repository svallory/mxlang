import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A fresh worker per file: Angular's TestBed is process-global. Under a
    // shared or module-reset process, 13+ files fail in beforeAll with "Cannot
    // set base providers because it has already been called" (e.g.
    // attr-interpolation-literal-render.test.ts). The threads pool isolates by
    // default; the forks pool's isolation is read only from the root config.
    pool: "threads",
    // Run after the forks projects (see the root vitest.config.ts).
    sequence: { groupOrder: 1 },
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
