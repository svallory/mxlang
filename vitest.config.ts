import { configDefaults, defineConfig } from "vitest/config";
import { currentLane, PROJECT_GLOBS } from "./scripts/vitest-lanes.ts";
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

// Root `poolOptions.forks.isolate: false` lets forks workers be reused across
// files (the per-project `isolate` flag alone only resets modules; it cannot
// defeat the root pool's per-file process). Projects that cannot share state
// keep `isolate: true` explicitly in their own config; every project is
// otherwise reset per file by vitest's module isolation settings.
//
// Core runs as two projects: the ordinary files share one module graph per
// worker, and these three keep per-file isolation:
// - syntax-stock-parser.test.ts: hoisted frontend mock; a cached importer
//   bypasses it (2 failures when shared).
// - ir-entry/ir-readonly.test.ts: compile mock freezes/records IR; cached
//   lowering bypasses it (7 failures when shared).
// - callee-input-probes.test.ts: registers `.solid.mx` with no unregister; the
//   reader map survives a module reset.
const CORE_ROOT = "packages/core";
const CORE_ISOLATED = [
  "src/syntax-stock-parser.test.ts",
  "src/ir-entry/ir-readonly.test.ts",
  "src/callee-input-probes.test.ts",
];
const coreProjects = [
  {
    test: {
      name: "@mxlang/core",
      root: CORE_ROOT,
      isolate: false,
      exclude: [...configDefaults.exclude, ...CORE_ISOLATED],
    },
  },
  {
    test: {
      name: "@mxlang/core-isolated",
      root: CORE_ROOT,
      isolate: true,
      include: CORE_ISOLATED,
    },
  },
];

const projects = PROJECT_GLOBS.flatMap((g) =>
  g === CORE_ROOT ? coreProjects : [g],
);

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
    poolOptions: { forks: { isolate: false } },
    projects: currentLane() === "slow" ? slowProjects : projects,
  },
});
