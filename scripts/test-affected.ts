#!/usr/bin/env bun
/**
 * Run only the tests the current change affects.
 *
 *   bun run test:affected            vitest related <source files changed vs origin/main>
 *                                    + vitest run --project <pkg> for changed non-source
 *                                      files (fixtures, expected.*, corpora, .json)
 *   bun run test:affected --moon     moon run :test --affected (task cache) — unverified,
 *                                    see AGENTS.md
 *   bun run test:affected -- <args>  extra args go to vitest (or moon with --moon)
 *
 * "Changed" is the union of the branch's commits since its merge-base with
 * origin/main, staged and unstaged edits, and untracked files.
 *
 * `vitest related` follows the import graph, so a changed fixture no test
 * imports would be silently skipped — and vitest 3 defaults `related` to
 * `passWithNoTests: true`, which turns "0 tests" into a green exit. Both are
 * closed here: `--passWithNoTests=false` makes a zero-test `related` run fail,
 * and every changed non-source file under a workspace package runs that
 * package's whole vitest project as a second invocation. A changed file that
 * maps to no project at all (docs, scripts without tests) is named explicitly
 * before exiting 0.
 *
 * The lane is always `all`: `vitest related` already selects only the affected
 * tests, so a fast lane would hide slow-lane tests it selected (the watch-mode
 * tsc tests import core and parser). Which slow-lane packages were touched is
 * still printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/** Packages whose tests have a slow lane (scripts/vitest-lanes.ts). */
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

/**
 * The slow-lane packages a change touches (for the printed note; the run
 * itself always uses lane `all`).
 */
export function laneFor(changed: readonly string[]): string[] {
  return SLOW_LANE_DIRS.filter((d) => changed.some((f) => f.startsWith(d))).map(
    (d) => d.replace(/\/$/, ""),
  );
}

export function isWide(file: string): boolean {
  return WIDE_FILES.some((re) => re.test(file));
}

/**
 * The vitest projects of the root config, as workspace-relative dirs (the same
 * list vitest.config.ts passes to `projects`). Only dirs that exist are kept.
 */
export function projectDirs(base = root): string[] {
  const globs = [
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
  return globs
    .flatMap((g) => globSync(g, { cwd: base, onlyFiles: false }))
    .map((d) => `${d.replace(/\/+$/, "")}/`)
    .filter((d) => existsSync(resolve(base, d)))
    .sort();
}

/**
 * The vitest project name owning a changed workspace-relative file: the
 * package.json name of the nearest enclosing project dir (vitest's own naming
 * rule for a config without `test.name`). `undefined` when the file is in no
 * project (docs, root scripts, apps/).
 */
export function projectFor(
  file: string,
  dirs?: readonly string[],
): string | undefined {
  const list = dirs ?? projectDirs();
  const f = `${file.replace(/\/+$/, "")}/`;
  let best: string | undefined;
  let bestLen = -1;
  for (const d of list) {
    if (f.startsWith(d) && d.length > bestLen) {
      bestLen = d.length;
      const pkgPath = resolve(root, d, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        best = pkg.name ?? d.replace(/\/$/, "");
      } catch {
        best = d.replace(/\/$/, "");
      }
    }
  }
  return best;
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

function run(cmd: string[], env: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: root,
    env,
    stdio: "inherit",
  });
  return r.status ?? 1;
}

function main(): number {
  const argv = process.argv.slice(2);
  const moon = argv.includes("--moon");
  const extra = argv.filter((a) => a !== "--moon");
  const changed = changedFiles();
  if (changed.length === 0) {
    console.log("test:affected: no changes vs origin/main; nothing to run.");
    return 0;
  }
  const sources = changed.filter((f) => SOURCE.test(f));
  const nonSources = changed.filter((f) => !SOURCE.test(f));
  const wide = changed.filter(isWide);
  if (wide.length > 0) {
    console.warn(
      `test:affected: ${wide.join(", ")} can affect tests the import graph does not show.\n` +
        "  Run the affected set, then let the gate (gate-auto.sh --packages ...) cover the rest.",
    );
  }
  const slowTouched = laneFor(changed);
  if (slowTouched.length > 0) {
    console.log(
      `test:affected: ${slowTouched.join(", ")} changed, so slow-lane tests (tsc watch programs, typescript-plugin index) may be selected; lane=all.`,
    );
  }
  const env = {
    ...process.env,
    MX_TEST_LANE: process.env.MX_TEST_LANE ?? "all",
  };

  if (moon) {
    console.log(
      `test:affected: MX_TEST_LANE=${env.MX_TEST_LANE} moon run :test --affected (unverified; moon is not installed on every host)`,
    );
    return run(["moon", "run", ":test", "--affected", ...extra], env);
  }

  let rc = 0;

  if (sources.length > 0) {
    // passWithNoTests=false: a change whose sources no test imports must not
    // exit green (vitest 3 defaults `related` to passWithNoTests).
    const cmd = [
      "bunx",
      "vitest",
      "related",
      ...sources,
      "--run",
      "--passWithNoTests=false",
      ...extra,
    ];
    console.log(
      `test:affected: MX_TEST_LANE=${env.MX_TEST_LANE} ${cmd.join(" ").slice(0, 200)}`,
    );
    rc = run(cmd, env);
  }

  // Changed files the import graph cannot see (fixtures, expected.*, corpora,
  // .json): run the vitest project of the package that owns each one.
  if (nonSources.length > 0) {
    const byProject = new Map<string, string[]>();
    const unmapped: string[] = [];
    for (const f of nonSources) {
      const p = projectFor(f);
      if (p) byProject.set(p, [...(byProject.get(p) ?? []), f]);
      else unmapped.push(f);
    }
    if (byProject.size > 0) {
      const projects = [...byProject.keys()];
      for (const [p, files] of byProject) {
        console.log(
          `test:affected: non-source change -> whole project ${p} (${files.join(", ")})`,
        );
      }
      const cmd = [
        "bunx",
        "vitest",
        "run",
        ...projects.flatMap((p) => ["--project", p]),
        "--passWithNoTests=false",
        ...extra,
      ];
      console.log(`test:affected: ${cmd.join(" ").slice(0, 200)}`);
      rc = Math.max(rc, run(cmd, env));
    }
    if (unmapped.length > 0) {
      // Explicit, not silent: these changed files belong to no vitest project.
      console.log(
        `test:affected: no vitest project covers ${unmapped.join(", ")}; covered by the gate instead.`,
      );
    }
  }

  return rc;
}

if (import.meta.main) process.exit(main());
