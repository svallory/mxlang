import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { laneTest, SLOW_LANE_FILES } from "../../../scripts/vitest-lanes.ts";

export default defineConfig({
  test: {
    name: "@mxlang/typescript-plugin",
    // Yields between tests so index.test.ts's ~176 synchronous language-service
    // tests cannot hold the event loop for the whole file (#390).
    setupFiles: [
      fileURLToPath(
        new URL("../../../scripts/vitest-yield.ts", import.meta.url),
      ),
    ],
    // index.test.ts (~176 language-service tests, ~90 s) is the slow lane
    // (scripts/vitest-lanes.ts); CI, the gate and a bare run still include it.
    ...laneTest(SLOW_LANE_FILES["packages/tooling/typescript-plugin"], {
      include: ["src/**/*.test.ts"],
    }),
    server: {
      deps: {
        // Descriptors synchronously require compile leaves, which use Node's
        // core instance. Transforming the linked dist again splits its editor
        // buffer overrides from the plugin's imports. core-identity.test.ts
        // pins the same native module boundary as the published artifact.
        external: [/packages\/core\/dist\//],
      },
    },
  },
});
