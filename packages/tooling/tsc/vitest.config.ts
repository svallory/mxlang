import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { laneTest, SLOW_LANE_FILES } from "../../../scripts/vitest-lanes.ts";

// The watch-mode tests each start real TypeScript watch programs and take
// 40-200 s apiece; with typescript-plugin's index.test.ts they are about half
// of the whole suite's CPU time. They are the "slow lane" (see
// scripts/vitest-lanes.ts): `MX_TEST_LANE=fast` leaves them out, and CI, the
// gate and a bare `vitest run` still run them. The two fast watch-* files
// (watch-compile 17 ms, watch-templates-helpers 0.3 s, from the forge baseline
// JSON) stay in the fast lane, which is why this is an explicit list.
export default defineConfig({
  test: {
    // Module reset per file in a reused process (root forks pool shares
    // workers). mx-tsc runs in-process and patches Volar's decorateProgram,
    // volar.getLanguagePlugins and process.stdout.isTTY once per process; with
    // a shared graph, watch-ambient-types.test.ts "mx-tsc -w reports a throwing
    // host on every build while it throws, and not after" failed three times
    // on this branch (expected 131 to be less than 89: the diagnostic printed
    // after the summary that counts it). It did not fail in 12 full and slow-lane
    // runs on main, nor in 12 on the shared-graph branch, so the cause is
    // inferred, not proven.
    poolOptions: { forks: { isolate: true } },
    // Yields between tests: a file's runInProcess tests are synchronous (about
    // 0.6 s each), so without a macrotask hop one file held the worker's event
    // loop for 5-10 s. TypeScript's cold load is not the cause (about 1 s, and
    // Node's require cache carries it across files).
    setupFiles: [
      fileURLToPath(
        new URL("../../../scripts/vitest-yield.ts", import.meta.url),
      ),
    ],
    ...laneTest(SLOW_LANE_FILES["packages/tooling/tsc"]),
  },
});
