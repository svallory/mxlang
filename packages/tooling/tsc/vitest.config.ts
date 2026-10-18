import { defineConfig } from "vitest/config";
import { laneTest } from "../../../scripts/vitest-lanes.ts";

// The watch-mode tests each start real TypeScript watch programs and take
// 40-110 s apiece, about half of the whole suite's CPU time. They are the
// "slow lane" (see scripts/vitest-lanes.ts): `MX_TEST_LANE=fast` leaves them
// out, and CI, the gate and a bare `vitest run` still run them.
export default defineConfig({
  test: {
    ...laneTest(["src/watch*.test.ts"]),
  },
});
