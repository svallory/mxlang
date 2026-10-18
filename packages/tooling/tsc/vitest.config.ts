import { defineConfig } from "vitest/config";
import { laneTest } from "../../../scripts/vitest-lanes.ts";

// The watch-mode tests each start real TypeScript watch programs and take
// 40-200 s apiece; with typescript-plugin's index.test.ts they are about half
// of the whole suite's CPU time. They are the "slow lane" (see
// scripts/vitest-lanes.ts): `MX_TEST_LANE=fast` leaves them out, and CI, the
// gate and a bare `vitest run` still run them. The two fast watch-* files
// (watch-compile 17 ms, watch-templates-helpers 0.3 s, from the forge baseline
// JSON) stay in the fast lane, which is why this is an explicit list.
export default defineConfig({
  test: {
    ...laneTest([
      "src/watch.test.ts",
      "src/watch-ambient-types.test.ts",
      "src/watch-mx-diagnostics.test.ts",
      "src/watch-ngmx-rebuild-diagnostics.test.ts",
      "src/watch-package-json.test.ts",
      "src/watch-policy-diagnostics.test.ts",
      "src/watch-rebuild-diagnostics.test.ts",
    ]),
  },
});
