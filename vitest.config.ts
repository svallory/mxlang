import { configDefaults, defineConfig } from "vitest/config";
import {
  CORE_DIR,
  CORE_ISOLATED_FILES,
  CORE_ISOLATED_PROJECT,
  CORE_PROJECT,
  currentLane,
  PROJECT_GLOBS,
} from "./scripts/vitest-lanes.ts";
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

// Root `poolOptions.forks.isolate: false` is what lets the forks pool reuse
// worker processes across files: vitest reads process isolation only from the
// root config. A project's own `isolate` / `poolOptions.forks.isolate: true`
// does NOT give it a fresh process; it makes vitest reset the module registry
// and mocks per file inside the reused process (hoisted `vi.mock`s apply again,
// source modules re-evaluate). Externalized/CJS modules, `globalThis`, process
// listeners and child processes still carry across files.
//
// Three tiers:
// - Module reset per file in a reused process (`isolate: true`): host-solid,
//   host-astro, host-preact, parser, language-server, vite-plugin,
//   target-registry, vscode and `@mxlang/core-isolated`. Each hoists mocks or holds shared emitter state
//   that a shared graph bypasses (the failing assertion, or for target-registry
//   and vscode the mocking test, is named in the project's vitest.config.ts).
// - Fresh worker per file (`pool: "threads"`, whose isolation defaults to true
//   and is not read from the forks root): host-angular and target-html, which
//   depend on process-level state a module reset does not clear. They run in
//   `sequence.groupOrder: 1`, after every forks project: vitest runs groups
//   one after another, so the threads pool never overlaps the forks pool and
//   each gets the full `maxWorkers` (the worker cap holds, `--maxWorkers=N`
//   including a percentage applies as usual, and `--maxWorkers=1` serializes).
// - Every other project (tsc, typescript-plugin, babel, tsx-bridge, react,
//   hono, oracle, angular-checker, web-elements, ...) shares
//   one module graph per worker with no reset.
//
const coreProjects = [
  {
    test: {
      name: CORE_PROJECT,
      root: CORE_DIR,
      isolate: false,
      exclude: [...configDefaults.exclude, ...CORE_ISOLATED_FILES],
    },
  },
  {
    test: {
      name: CORE_ISOLATED_PROJECT,
      root: CORE_DIR,
      isolate: true,
      include: [...CORE_ISOLATED_FILES],
    },
  },
];

const projects = PROJECT_GLOBS.flatMap((g) =>
  g === CORE_DIR ? coreProjects : [g],
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
