#!/usr/bin/env bun
/**
 * Run only the tests the current change affects.
 *
 *   bun run test:affected            vitest related <non-fixture sources changed vs origin/main>
 *                                    + vitest run --project <pkg> for every other changed
 *                                      file (.mx, fixtures, expected.*, corpora, .json)
 *   bun run test:affected --moon     moon run :test --affected (task cache) — unverified,
 *                                    see AGENTS.md
 *   bun run test:affected -- <args>  extra args go to vitest (or moon with --moon)
 *
 * The selection cache (on by default locally; off with `CI` set,
 * `MX_AFFECTED_NATIVE=1` or `MX_AFFECTED_CACHE=0`) caches the import lists `vitest related` computes
 * while selecting, so a warm selection takes under a second instead of ~15 s.
 * Native `vitest related` still selects and runs; any doubt falls back to
 * native. See scripts/test-affected-cache.ts.
 *
 * "Changed" is the union of the branch's commits since its merge-base with
 * origin/main, staged and unstaged edits, and untracked files.
 *
 * `vitest related` follows the import graph, so a changed file that no test
 * imports — the dominant kind being `.mx` fixtures read through `fs` — would
 * be silently skipped, and vitest 3 defaults `related` to `passWithNoTests:
 * true`, which turns "0 tests" into a green exit. Both are closed here: only
 * non-fixture JS/TS sources go to `vitest related`, with
 * `--passWithNoTests=false` so a zero-test run fails; every other changed
 * file under a workspace package (fixtures whatever their extension, `.mx`,
 * `.json`, corpora) runs that package's whole vitest project as a second
 * invocation. A changed file that maps to no project at all (docs, scripts
 * without tests) is named explicitly before exiting 0.
 *
 * The lane is always `all`: `vitest related` already selects only the affected
 * tests, so a fast lane would hide slow-lane tests it selected (the watch-mode
 * tsc tests import core and parser). Which slow-lane packages were touched is
 * still printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { cacheMode } from "./test-affected-cache.ts";
import {
  CORE_DIR,
  CORE_ISOLATED_PROJECT,
  PROJECT_GLOBS,
} from "./vitest-lanes.ts";

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

/** The oracle test that renders every host in a probe subprocess. */
export const PROBE_CONSUMER = "packages/oracle/src/attribute-value.test.ts";

/**
 * Tests that depend on files through a subprocess, which the import graph
 * cannot see: the attribute-value probe renders each host's `src/**` and the
 * oracle test spawns it, so a change to either selects that test.
 */
export function probeConsumers(changed: readonly string[]): string[] {
  const hit = changed.some(
    (f) =>
      f === "scripts/attribute-value-probe.ts" ||
      /^packages\/hosts\/(?:preact|react|hono|solid|astro)\/src\//.test(f),
  );
  return hit ? [PROBE_CONSUMER] : [];
}

/**
 * Fixture directories a test in a DIFFERENT project (or in no project's dir)
 * reads, by a relative path or an import that hops out of its own package.
 * `projectsFor` maps a changed fixture only to the project that owns it, so
 * without this table a change here would skip (or, for a directory in no
 * project, never run) the tests that read it. Each row lists every consumer
 * test file a `git grep` for paths into that directory found; a path built at
 * run time is not detected, so a new reader adds its row by hand.
 */
export const FIXTURE_CONSUMERS: readonly {
  path: RegExp;
  consumers: readonly string[];
}[] = [
  {
    path: /^packages\/oracle\/fixtures\/angular\//,
    consumers: ["packages/hosts/angular/test/ng-mx-mapping-invariant.test.ts"],
  },
  {
    path: /^packages\/tooling\/tsc\/src\/fixtures\/host-dispatch\/alias-html\//,
    consumers: [
      "packages/tooling/typescript-plugin/src/tsconfig-paths-callee.test.ts",
    ],
  },
  {
    path: /^packages\/editors\/tree-sitter-mx\/test\/corpus\//,
    consumers: ["packages/core/src/ir-entry/conformance.test.ts"],
  },
  {
    path: /^packages\/core\/src\/fixtures\/syntax\/atom-fixture\.ts$/,
    consumers: [
      "packages/hosts/preact/src/expression-mappings.test.ts",
      "packages/hosts/solid/src/bridge/mx.test.ts",
      "packages/hosts/solid/src/expression-mappings.test.ts",
      "packages/targets/html/src/expression-mappings.test.ts",
    ],
  },
  {
    path: /^packages\/core\/src\/fixtures\/syntax\/member-fixture\.ts$/,
    consumers: ["packages/targets/html/src/member-syntax.test.ts"],
  },
  {
    path: /^fixtures\//,
    consumers: [
      "packages/hosts/solid/src/bridge/print.test.ts",
      "packages/oracle/src/oracle.test.ts",
    ],
  },
  {
    path: /^test-fixtures\/body-whitespace\//,
    consumers: [
      "packages/core/src/body-whitespace.test.ts",
      "packages/core/src/ir-entry/parse.test.ts",
      "packages/hosts/angular/test/body-whitespace.test.ts",
      "packages/hosts/astro/src/body-whitespace.test.ts",
      "packages/hosts/hono/src/dynamic-body.test.ts",
      "packages/hosts/preact/src/dynamic-body.test.ts",
      "packages/hosts/react/src/dynamic-body.test.ts",
      "packages/hosts/solid/src/body-content.test.ts",
      "packages/targets/html/src/dynamic-body.test.ts",
    ],
  },
  {
    path: /^test-fixtures\/third-party-targets\//,
    consumers: [
      "packages/core/src/target-loader-miss.test.ts",
      "packages/core/src/third-party-target.test.ts",
      "packages/target-registry/src/default-tag.test.ts",
      "packages/tooling/tsc/src/ambient-types-throw.test.ts",
      "packages/tooling/tsc/src/third-party-target.test.ts",
      "packages/tooling/tsc/src/watch-ambient-types.test.ts",
      "packages/tooling/typescript-plugin/src/ambient-types.test.ts",
      "packages/tooling/typescript-plugin/src/tsserver-load.test.ts",
    ],
  },
  {
    path: /^test-fixtures\/dialects\//,
    consumers: [
      "packages/target-registry/src/dialect-check-tag-dirs.test.ts",
      "packages/target-registry/src/dialect-check.test.ts",
      "packages/target-registry/src/dialect-contracts.test.ts",
      "packages/target-registry/src/dialect-diagnostic-codes.test.ts",
      "packages/target-registry/src/dialect-lower-options.test.ts",
      "packages/tooling/language-server/src/diagnose.test.ts",
      "packages/tooling/language-server/src/dialect-contracts.test.ts",
      "packages/tooling/language-server/src/dialect-lower-options.test.ts",
      "packages/tooling/language-server/src/server.test.ts",
      "packages/tooling/tsc/src/dialect-files.test.ts",
      "packages/tooling/tsc/src/dialect-lower-options.test.ts",
      "packages/tooling/tsc/src/fix-output.test.ts",
      "packages/tooling/typescript-plugin/src/dialect-files.test.ts",
      "packages/tooling/vite-plugin/src/dialect-files.test.ts",
      "packages/tooling/vite-plugin/src/index.test.ts",
    ],
  },
];

/** The consumer test files (`FIXTURE_CONSUMERS`) that read `file` from another project. */
export function fixtureConsumers(file: string): string[] {
  return FIXTURE_CONSUMERS.filter((row) => row.path.test(file)).flatMap(
    (row) => row.consumers,
  );
}

/**
 * The vitest projects to run whole for the changed files the import graph
 * cannot see: each file's owning projects (`projectsFor`) plus the project of
 * every test in another project that reads it (`FIXTURE_CONSUMERS`). A file
 * with neither is `unmapped`.
 */
export function nonSourceProjects(
  nonSources: readonly string[],
  dirs: readonly string[] = projectDirs(),
): { byProject: Map<string, string[]>; unmapped: string[] } {
  const byProject = new Map<string, string[]>();
  const unmapped: string[] = [];
  for (const f of nonSources) {
    const ps = new Set(projectsFor(f, dirs));
    for (const consumer of fixtureConsumers(f)) {
      const p = projectFor(consumer, dirs);
      if (p !== undefined) ps.add(p);
    }
    for (const p of ps) byProject.set(p, [...(byProject.get(p) ?? []), f]);
    if (ps.size === 0) unmapped.push(f);
  }
  return { byProject, unmapped };
}

/**
 * What `vitest related` gets: the changed related sources, the subprocess
 * probe's consumer (`probeConsumers`) and, for a related source under a
 * `FIXTURE_CONSUMERS` path (the tree-sitter-mx corpus readers, say), the
 * tests in other projects that read it. Deduped, in that order.
 */
export function relatedSources(changed: readonly string[]): string[] {
  const related = changed.filter(isRelatedSource);
  return [
    ...new Set([
      ...related,
      ...probeConsumers(changed),
      ...related.flatMap(fixtureConsumers),
    ]),
  ];
}

export function isWide(file: string): boolean {
  return WIDE_FILES.some((re) => re.test(file));
}

/**
 * The vitest projects of the root config (PROJECT_GLOBS in
 * scripts/vitest-lanes.ts — the same single source the root
 * vitest.config.ts uses), as workspace-relative dirs. Only dirs that exist
 * are kept.
 */
export function projectDirs(base = root): string[] {
  return PROJECT_GLOBS.flatMap((g) =>
    globSync(g, { cwd: base, onlyFiles: false }),
  )
    .map((d) => `${d.replace(/\/+$/, "")}/`)
    .filter((d) => existsSync(resolve(base, d)))
    .sort();
}

/** A file under a fixtures-style directory: tests read it through `fs`, never an import. */
const FIXTURE_DIR = /(?:^|\/)(?:fixtures[^/]*|test-fixtures)\//;

const SOURCE_EXT = /\.[cm]?[jt]sx?$/;

/**
 * A file `vitest related` can see: a JS/TS source that is not under a
 * fixtures-style directory. `.mx` files and fixtures of any extension map to
 * their project instead — tests read them through the filesystem, so the
 * import graph would silently drop them (and a mixed change would stay green).
 */
export function isRelatedSource(file: string): boolean {
  return SOURCE_EXT.test(file) && !FIXTURE_DIR.test(file);
}

/** The longest project dir (`dirs` entries end in `/`) enclosing `file`, if any. */
function ownerDir(file: string, list: readonly string[]): string | undefined {
  const f = `${file.replace(/\/+$/, "")}/`;
  let best: string | undefined;
  for (const d of list) {
    if (f.startsWith(d) && (!best || d.length > best.length)) best = d;
  }
  return best;
}

/**
 * The vitest project name owning a changed workspace-relative file: the
 * `test.name` of the project's vitest config when it sets one, else the
 * package.json name, else the dir's basename (vitest's own naming rules for
 * a config without `test.name`: `basename(dir)`, so a nested dir with no
 * package.json, e.g. one a rename left holding only ignored files, is
 * `tree-sitter-amx`, not `packages/editors/tree-sitter-amx`). `undefined` when the file is in no project
 * (docs, root scripts, apps/).
 */
export function projectFor(
  file: string,
  dirs?: readonly string[],
): string | undefined {
  const owner = ownerDir(file, dirs ?? projectDirs());
  return owner === undefined ? undefined : projectName(owner);
}

/**
 * Extra vitest projects a project dir owns beside the one `projectName` names:
 * `packages/core` runs as `@mxlang/core` plus `@mxlang/core-isolated` (three
 * files that need a module reset per file; see the root vitest.config.ts).
 */
export const SIBLING_PROJECTS: Readonly<Record<string, readonly string[]>> = {
  [`${CORE_DIR}/`]: [CORE_ISOLATED_PROJECT],
};

/** Every vitest project owning a changed file: `projectFor`'s name plus its dir's siblings. */
export function projectsFor(file: string, dirs?: readonly string[]): string[] {
  const owner = ownerDir(file, dirs ?? projectDirs());
  if (owner === undefined) return [];
  return [projectName(owner), ...(SIBLING_PROJECTS[owner] ?? [])];
}

function projectName(dir: string): string {
  // An explicit test.name in the project's vitest config wins: vscode's
  // package.json name ("vscode") differs from its vitest project name
  // ("@mxlang/vscode"), so the package.json alone would name a project that
  // does not exist.
  const cfg = resolve(root, dir, "vitest.config.ts");
  if (existsSync(cfg)) {
    const m = /\bname:\s*["']([^"']+)["']/.exec(readFileSync(cfg, "utf8"));
    if (m) return m[1];
  }
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(root, dir, "package.json"), "utf8"),
    );
    return pkg.name || basename(dir);
  } catch {
    return basename(dir);
  }
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

function run(cmd: string[], env: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: root,
    env,
    stdio: "inherit",
  });
  return r.status ?? 1;
}

/**
 * Extra vitest args that turn on the selection cache: a reporter that serves
 * cached import lists during native `vitest related` selection (see
 * test-affected-cache.ts). Empty (native, no cache read) with CI set,
 * MX_AFFECTED_NATIVE=1 or MX_AFFECTED_CACHE=0.
 */
export function cacheArgs(
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): string[] {
  if (!cacheMode(env).on) return [];
  // Naming a reporter on the CLI replaces the config's reporters, so the
  // default one is kept unless the caller picked their own.
  const own = extra.some(
    (a) => a === "--reporter" || a.startsWith("--reporter="),
  );
  return [
    ...(own ? [] : ["--reporter=default"]),
    `--reporter=${resolve(import.meta.dirname, "test-affected-cache-reporter.ts")}`,
  ];
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
  const sources = relatedSources(changed);
  const nonSources = changed.filter((f) => !isRelatedSource(f));
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
    MX_TEST_LANE: "all",
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
      ...cacheArgs(process.env, extra),
      ...extra,
    ];
    console.log(
      `test:affected: MX_TEST_LANE=${env.MX_TEST_LANE} ${cmd.join(" ").slice(0, 200)}`,
    );
    rc = run(cmd, env);
  }

  // Changed files the import graph cannot see (.mx files, fixtures of any
  // extension, corpora, .json): run the vitest project of the package that
  // owns each one, plus the project of each test elsewhere that reads it.
  if (nonSources.length > 0) {
    const { byProject, unmapped } = nonSourceProjects(nonSources);
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
