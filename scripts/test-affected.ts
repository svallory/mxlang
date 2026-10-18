#!/usr/bin/env bun
/**
 * Run only the tests the current change affects.
 *
 *   bun run test:affected            vitest related <files changed vs origin/main>
 *   bun run test:affected --moon     moon run :test --affected (task cache)
 *   bun run test:affected -- <args>  extra args go to vitest (or moon with --moon)
 *
 * "Changed" is the union of the branch's commits since its merge-base with
 * origin/main, staged and unstaged edits, and untracked files. The slow lane
 * (scripts/vitest-lanes.ts) runs only when a package that owns slow tests
 * changed; CI and the gate always run it.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Packages whose tests have a slow lane. Changing one of them turns it on. */
export const SLOW_LANE_DIRS = [
  "packages/tooling/tsc/",
  "packages/tooling/typescript-plugin/",
];

/** Files whose change can affect tests no import graph shows. */
const WIDE_FILES = [
  /^vitest\.config\.ts$/,
  /^package\.json$/,
  /^bun\.lock$/,
  /^tsconfig\.base\.json$/,
  /^scripts\/vitest-/,
  /\/vitest\.config\.ts$/,
];

export function laneFor(changed: readonly string[]): "all" | "fast" {
  return changed.some((f) => SLOW_LANE_DIRS.some((d) => f.startsWith(d)))
    ? "all"
    : "fast";
}

export function isWide(file: string): boolean {
  return WIDE_FILES.some((re) => re.test(file));
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

export function changedFiles(base = "origin/main"): string[] {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const names = new Set<string>();
  for (const out of [
    git(["diff", "--name-only", "--diff-filter=d", mergeBase]),
    git(["ls-files", "--others", "--exclude-standard"]),
  ]) {
    for (const line of out.split("\n")) if (line) names.add(line);
  }
  return [...names].filter((f) => existsSync(resolve(root, f))).sort();
}

const SOURCE = /\.(?:[cm]?[jt]sx?|mx)$/;

function main(): number {
  const argv = process.argv.slice(2);
  const moon = argv.includes("--moon");
  const extra = argv.filter((a) => a !== "--moon");
  const changed = changedFiles();
  const sources = changed.filter((f) => SOURCE.test(f));
  if (sources.length === 0) {
    console.log(
      "test:affected: no source files changed vs origin/main; nothing to run.",
    );
    return 0;
  }
  const wide = changed.filter(isWide);
  if (wide.length > 0) {
    console.warn(
      `test:affected: ${wide.join(", ")} can affect tests the import graph does not show.\n` +
        "  Run the affected set, then let the gate (gate-auto.sh --packages ...) cover the rest.",
    );
  }
  const lane = laneFor(changed);
  const env = {
    ...process.env,
    MX_TEST_LANE: process.env.MX_TEST_LANE ?? lane,
  };
  if (env.MX_TEST_LANE === "fast") {
    console.log(
      "test:affected: fast lane (tsc/typescript-plugin unchanged); the slow lane runs in the gate and CI.",
    );
  }
  const cmd = moon
    ? ["moon", "run", ":test", "--affected", ...extra]
    : ["bunx", "vitest", "related", ...sources, "--run", ...extra];
  console.log(
    `test:affected: MX_TEST_LANE=${env.MX_TEST_LANE} ${cmd.join(" ").slice(0, 200)}`,
  );
  const r = spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd: root,
    env,
    stdio: "inherit",
  });
  return r.status ?? 1;
}

if (import.meta.main) process.exit(main());
