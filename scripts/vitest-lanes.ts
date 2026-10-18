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
 * A project opts in by passing its slow globs (relative to the project root)
 * to `laneTest(...)` and spreading the result into its `test` config. The fast
 * and slow lanes partition the files exactly: `scripts/vitest-lanes.test.ts`
 * checks the two sets add up to the whole project.
 */
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
