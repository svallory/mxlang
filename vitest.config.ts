import { defineConfig } from "vitest/config";
import { currentLane } from "./scripts/vitest-lanes.ts";

// Outside CI, cap the worker pool. A whole-suite run in this monorepo forks one
// worker per core and each loads full TypeScript programs (1-4 GB), which has
// filled a 16 GB laptop and crashed it twice. Override with VITEST_MAX_WORKERS=n.
const localWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2);

const projects = [
  "scripts",
  "patches",
  "packages/babel",
  "packages/core",
  "packages/oracle",
  "packages/parser",
  "packages/parse-differential",
  "packages/stock-marko",
  "packages/tsx-bridge",
  "packages/target-registry",
  "packages/web-elements",
  "packages/hosts/*",
  "packages/targets/*",
  "packages/tooling/*",
  "packages/editors/*",
];

// `MX_TEST_LANE=slow` must run only the slow files. Every project other than
// the two that carry them (tsc, typescript-plugin) has no slow glob, so
// narrowing the project list is what keeps the slow lane slow; `fast` needs no
// narrowing because each slow project excludes its own slow files. Unset
// (`all`) is the default and changes nothing.
const slowProjects = [
  "packages/tooling/tsc",
  "packages/tooling/typescript-plugin",
];

export default defineConfig({
  test: {
    ...(process.env.CI ? {} : { maxWorkers: localWorkers }),
    projects: currentLane() === "slow" ? slowProjects : projects,
  },
});
