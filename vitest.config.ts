import { defineConfig } from "vitest/config";
import { currentLane } from "./scripts/vitest-lanes.ts";
import { resolveWorkers, workersLogLine } from "./scripts/vitest-workers.ts";

// Workers are capped by free memory (operator ruling 2026-10-19):
// clamp(floor(MemAvailable / 1 GiB), 1, availableParallelism - 1), so a
// memory-starved box cannot fork one TypeScript-loaded worker per core
// (a 14-core / 9 GB WSL2 box did exactly that and was OOM-killed). An explicit
// `--maxWorkers` (CLI, overrides config) or `VITEST_MAX_WORKERS` still wins.
// Printed once at startup; MX_VITEST_QUIET=1 silences the line.
const resolved = resolveWorkers();
if (!process.env.MX_VITEST_QUIET) {
  console.warn(workersLogLine(resolved));
}

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
    maxWorkers: resolved.workers,
    projects: currentLane() === "slow" ? slowProjects : projects,
  },
});
