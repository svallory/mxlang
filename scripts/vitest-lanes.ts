import { configDefaults } from "vitest/config";

/**
 * Fast/slow test lanes, selected by `MX_TEST_LANE`.
 *
 * - unset or `all`: every file runs. This is what CI, the gate and a bare
 *   `vitest run` use, so nothing is ever dropped by default.
 * - `fast`: the slow files are left out (`bun run test:fast`, and
 *   `bun run test:affected` when no slow-lane package changed).
 * - `slow`: only the slow files run (`bun run test:slow`).
 *
 * A project opts in by passing its slow files (relative to the project root)
 * to `laneTest(...)` and spreading the result into its `test` config. The slow
 * lists live here (SLOW_LANE_FILES) so `scripts/vitest-lanes.test.ts` can
 * assert every listed file still exists — a renamed slow file would otherwise
 * silently leave the slow lane while "fast + slow == all" stays trivially
 * true.
 */

/**
 * The root vitest config's `projects` globs, as the single source of truth:
 * the root `vitest.config.ts` resolves its projects from this list, and
 * `scripts/test-affected.ts` maps changed fixture files to their vitest
 * project through it. Keep both consumers importing from here so they cannot
 * drift apart.
 */
export const PROJECT_GLOBS: readonly string[] = [
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

/**
 * `packages/core` runs as two vitest projects: the ordinary files share one
 * module graph per worker, and these three get a module reset per file in a
 * reused process. Single
 * source for the root config and for `scripts/test-affected.ts`.
 */
export const CORE_DIR = "packages/core";
export const CORE_PROJECT = "@mxlang/core";
export const CORE_ISOLATED_PROJECT = "@mxlang/core-isolated";
export const CORE_ISOLATED_FILES: readonly string[] = [
  // hoisted frontend mock: a cached importer bypasses it when shared
  "src/syntax-stock-parser.test.ts",
  // hoisted compile mock freezes/records IR: cached lowering bypasses it
  "src/ir-entry/ir-readonly.test.ts",
  // registers `.solid.mx` with no unregister; the reader map is in callee-input.ts
  "src/callee-input-probes.test.ts",
];

/** Slow-lane test files per project dir, relative to the project root. */
export const SLOW_LANE_FILES: Readonly<Record<string, readonly string[]>> = {
  "packages/tooling/tsc": [
    "src/build-cache-build.test.ts",
    "src/watch.test.ts",
    "src/watch-ambient-types.test.ts",
    "src/watch-mx-diagnostics.test.ts",
    "src/watch-ngmx-rebuild-diagnostics.test.ts",
    "src/watch-package-json.test.ts",
    "src/watch-policy-diagnostics.test.ts",
    "src/watch-rebuild-diagnostics.test.ts",
  ],
  "packages/tooling/typescript-plugin": ["src/index.test.ts"],
};
export type Lane = "all" | "fast" | "slow";

export function currentLane(env: NodeJS.ProcessEnv = process.env): Lane {
  const lane = env.MX_TEST_LANE;
  if (lane === undefined || lane === "" || lane === "all") return "all";
  if (lane === "fast" || lane === "slow") return lane;
  throw new Error(
    `MX_TEST_LANE must be "all", "fast" or "slow", got "${lane}". Unset it to run every test.`,
  );
}

export interface LaneTestConfig {
  include?: string[];
  exclude: string[];
}

export interface LaneOptions {
  /** The project's own `include`, kept as is in the `all` and `fast` lanes. */
  include?: readonly string[];
  /** The project's own `exclude`; defaults to vitest's. */
  exclude?: readonly string[];
  lane?: Lane;
}

export function laneTest(
  slowGlobs: readonly string[],
  options: LaneOptions = {},
): LaneTestConfig {
  const lane = options.lane ?? currentLane();
  const exclude = [...(options.exclude ?? configDefaults.exclude)];
  const own = options.include ? { include: [...options.include] } : {};
  if (lane === "slow") return { include: [...slowGlobs], exclude };
  if (lane === "fast") return { ...own, exclude: [...exclude, ...slowGlobs] };
  return { ...own, exclude };
}
