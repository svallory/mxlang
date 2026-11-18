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
 * non-fixture JS/TS sources, and not vitest/vite config files (no test imports
 * them; each runs its project whole, the root one is left to the gate), go to
 * `vitest related`, with
 * `--passWithNoTests=false` so a zero-test run fails; every other changed
 * file under a workspace package (fixtures whatever their extension, `.mx`,
 * `.json`, corpora) runs that package's whole vitest project as a second
 * invocation. A changed file that maps to no project at all (docs, scripts
 * without tests) is named explicitly before exiting 0.
 *
 * A `.md` inside a project dir (outside fixtures-style dirs and
 * `FIXTURE_CONSUMERS` rows) runs only the Markdown readers (`DOC_READERS`,
 * through `vitest related`), never its whole project or own test script.
 * A file matched only by `readersOnly` `FIXTURE_CONSUMERS` rows (the
 * `apps/docs/docs` pages, core's message-vocabulary allowlist) runs only the
 * rows' consumer test files through `vitest related`, never its owner's or a
 * consumer's whole project.
 *
 * A JS/TS source whose edit changes only comments or same-line whitespace is
 * left out (`commentOnly`, `commentOnlySplit`): TypeScript's parser reads the
 * merge-base text (`git show`) and the working-tree text, and the file is
 * left out only when the ordered tokens, the line breaks between them, the
 * shebang and every load-bearing marker comment (`@ts-`, `biome-ignore`,
 * `__PURE__` and the rest of `COMMENT_MARKERS`) are equal. The tests that read
 * such a file's text (`SOURCE_TEXT_READERS`) still run. A file that is new,
 * renamed or untracked, a fixture, `.mx`, `.json`, `.md` or a wide file keeps
 * today's selection. The gate and CI run every test.
 *
 * A project that owns a changed file but has no vitest test files (the
 * tree-sitter grammars, whose tests are `*.bun-test.mts`, and the Zed
 * extension) is not given to `vitest run --project`, which would fail with
 * "No test files found": its package's own `test` script runs instead, or,
 * when it has none, it is named and skipped (CI covers it). Its sources stay
 * in the `vitest related` call so tests elsewhere that import them are still
 * selected; that call passes with no tests only when every changed related
 * source belongs to such a project.
 *
 * The lane is always `all`: `vitest related` already selects only the affected
 * tests, so a fast lane would hide slow-lane tests it selected (the watch-mode
 * tsc tests import core and parser). Which slow-lane packages were touched is
 * still printed.
 *
 * Core parses through `packages/parser/dist/babel.js`, a bundle of the Babel
 * fork, so a change to one of its build inputs (`PARSER_BUILD_INPUTS`) first
 * rebuilds that dist; under `--moon`, `core:test`'s `parser:build` dep does.
 */
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import ts from "typescript";
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
 * The inputs of `packages/parser/dist/babel.js`, the bundle core parses
 * through. Keep in step with `parser:build`'s inputs in
 * packages/parser/moon.yml: the lockfile (the bundle inlines the locked npm
 * code) and the tsconfig chain count too, so a lockfile bump rebuilds it.
 */
const PARSER_BUILD_INPUTS: readonly RegExp[] = [
  /^packages\/babel\/src\//,
  /^packages\/babel\/package\.json$/,
  /^packages\/parser\/src\/frontend\/babel\.ts$/,
  /^packages\/parser\/package\.json$/,
  /^packages\/parser\/tsconfig\.json$/,
  /^bun\.lock$/,
  /^tsconfig\.base\.json$/,
];

function isParserBuildInput(file: string): boolean {
  return PARSER_BUILD_INPUTS.some((re) => re.test(file));
}

/**
 * Whether the change touches an input of `packages/parser/dist/babel.js`, so
 * `main()` must rebuild it before core's tests read it.
 */
export function parserBuildNeeded(changed: readonly string[]): boolean {
  return changed.some(isParserBuildInput);
}

/**
 * Files outside the import graph (fixtures, docs, manifests, patches, the
 * lockfile, root config) that a test in a DIFFERENT project (or in no
 * project's dir) reads, or that any test reads for a project doc, by a
 * relative path or an import that hops out of its own package. `projectsFor`
 * maps a changed file only to the project that owns it, a project doc
 * (`isProjectDoc`) selects no project at all, and a file in no project runs
 * nothing, so without this table a change here would skip the tests that
 * read it. Each row lists every consumer test file that reads what it
 * matches. The "FIXTURE_CONSUMERS guard" in `scripts/test-affected.test.ts`
 * fails when a test it detects reading such a file has no row; it cannot see
 * a path built in another module, passed through a function parameter of an
 * imported helper, written root-relative inside a string, built from an
 * imported constant or helper, loaded through `require`, or enumerated
 * through git, so such a reader adds its row by hand.
 *
 * `readersOnly`: a changed file matched only by `readersOnly` rows
 * (`readersOnly()`) runs exactly the rows' consumer files through `vitest
 * related`, never its owner's project or a consumer's project. Use it only
 * when the row lists every test that reads the file: the guard then treats
 * the file as having no owner, so a same-project reader needs the row too.
 */
export const FIXTURE_CONSUMERS: readonly {
  path: RegExp;
  consumers: readonly string[];
  readersOnly?: true;
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
    path: /^packages\/tooling\/tsc\/src\/fixtures\/host-dispatch\/astro-mx\//,
    consumers: [
      "packages/tooling/typescript-plugin/src/amx-custom-tag-tsx.test.ts",
    ],
  },
  {
    path: /^packages\/tooling\/tsc\/src\/fixtures\/ng-diag-tag-import\//,
    consumers: [
      "packages/tooling/typescript-plugin/src/index.test.ts",
      "packages/tooling/typescript-plugin/src/target-dispatch.test.ts",
      "packages/tooling/typescript-plugin/src/tsserver-load.test.ts",
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
    path: /^packages\/core\/src\/message-vocabulary-guard\.allowlist\.txt$/,
    consumers: ["packages/core/src/message-vocabulary-guard.test.ts"],
    readersOnly: true,
  },
  {
    path: /^packages\/babel\/UPSTREAM\.md$/,
    consumers: ["scripts/pack-hygiene.test.ts"],
  },
  {
    path: /^packages\/editors\/vscode\/package\.json$/,
    consumers: ["packages/target-registry/src/parity.test.ts"],
  },
  {
    path: /^packages\/parser\/src\/template\/(?:mx-nameless-ascii|mx-unicode-words)\.main\.json$/,
    consumers: ["patches/htmljs-parser.test.ts"],
  },
  {
    path: /^packages\/tooling\/(?:language-server|typescript-plugin)\/package\.json$/,
    consumers: [
      "packages/editors/vscode/scripts/bundled-entries.test.ts",
      "packages/tooling/tsc/src/peer-typescript.test.ts",
    ],
  },
  {
    // Every workspace manifest (`WORKSPACE_PARENTS` in `scripts/pack-hygiene.ts`).
    path: /^(?:packages\/(?:[^/]+\/)?[^/]+|examples\/[^/]+|apps\/[^/]+)\/package\.json$/,
    consumers: [
      "scripts/pack-hygiene.test.ts",
      "scripts/workspace-cycles.test.ts",
    ],
  },
  {
    path: /^examples\/angular-app\//,
    consumers: ["packages/hosts/angular/test/example-app.test.ts"],
  },
  {
    path: /^examples\/astro-static\/src\/components\//,
    consumers: ["packages/tooling/typescript-plugin/src/index.test.ts"],
  },
  {
    path: /^apps\/docs\/docs\/architecture\/ast\.md$/,
    consumers: ["packages/babel/src/mx-ast.test.ts"],
    readersOnly: true,
  },
  {
    path: /^apps\/docs\/docs\/architecture\/ir-entry\.md$/,
    consumers: ["packages/core/src/ir-entry/partial.test.ts"],
    readersOnly: true,
  },
  {
    path: /^apps\/docs\/docs\/architecture\/parser-grammar\.md$/,
    consumers: ["packages/parser/src/template/grammar-spec.test.ts"],
    readersOnly: true,
  },
  {
    path: /^apps\/docs\/docs\/custom-tags\/sidecars\.md$/,
    consumers: ["packages/core/src/parents.test.ts"],
    readersOnly: true,
  },
  {
    path: /^apps\/docs\/docs\/language\/attr-tag\.md$/,
    consumers: [
      "packages/hosts/preact/src/attr-tag-docs.test.ts",
      "packages/targets/html/src/attr-tag-docs.test.ts",
    ],
    readersOnly: true,
  },
  {
    path: /^apps\/docs\/docs\/specification\.md$/,
    consumers: [
      "packages/core/src/ir-entry/partial.test.ts",
      "packages/core/src/parents.test.ts",
    ],
    readersOnly: true,
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
  {
    path: /^patches\/htmljs-parser@5\.18\.0\.patch$/,
    consumers: [
      "packages/stock-marko/src/vendor.test.ts",
      "packages/targets/html/src/stock-parser.test.ts",
    ],
  },
  {
    path: /^\.gitignore$/,
    consumers: ["packages/editors/vscode/scripts/bundled-entries.test.ts"],
  },
  {
    path: /^bun\.lock$/,
    consumers: ["packages/stock-marko/src/vendor.test.ts"],
  },
  {
    path: /^package\.json$/,
    consumers: ["packages/stock-marko/src/marko.test.ts"],
  },
];

/** The consumer test files (`FIXTURE_CONSUMERS`) that read `file` from another project. */
export function fixtureConsumers(file: string): string[] {
  return FIXTURE_CONSUMERS.filter((row) => row.path.test(file)).flatMap(
    (row) => row.consumers,
  );
}

/**
 * Whether `file` is readers-only: at least one row of `rows` matches it and
 * every matching row has `readersOnly`. Such a file runs only its rows'
 * consumer files (`relatedSources`), never a whole project (`splitDocs`).
 */
export function readersOnly(
  file: string,
  rows: readonly { path: RegExp; readersOnly?: true }[] = FIXTURE_CONSUMERS,
): boolean {
  const matching = rows.filter((row) => row.path.test(file));
  return (
    matching.length > 0 && matching.every((row) => row.readersOnly === true)
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
 * Tests that read Markdown files by enumerating them. corpus-equivalence reads
 * the `mx`/`marko` fences of every tracked Markdown file and every tracked
 * `.mx`/`.marko`/`.amx` file (`git ls-files`), so any changed corpus input
 * (`CORPUS_INPUT`: a `.md`, `.mdx`, `.mx`, `.marko` or `.amx` file anywhere)
 * selects it whatever the file contains. A test that reads named files adds a
 * `FIXTURE_CONSUMERS` row instead.
 */
export const DOC_READERS: readonly string[] = [
  "packages/parser/src/template/corpus-equivalence.test.ts",
];

/** A corpus-equivalence input: its `git ls-files` walk reads every tracked file this matches. */
const CORPUS_INPUT = /\.(?:mdx?|mx|marko|amx)$/;

/**
 * A project doc: a `.md` inside a project dir that is not under a
 * fixtures-style dir and not on a `FIXTURE_CONSUMERS` row. It maps to the
 * Markdown readers (`DOC_READERS`), never to its owner's whole project.
 */
export function isProjectDoc(file: string, dirs: readonly string[]): boolean {
  return (
    /\.md$/.test(file) &&
    ownerDir(file, dirs) !== undefined &&
    !FIXTURE_DIR.test(file) &&
    fixtureConsumers(file).length === 0
  );
}

/**
 * `changed` split into project docs (`isProjectDoc`), readers-only files
 * (`readersOnly`) and the rest, each part in input order. Neither of the
 * first two reaches a whole project.
 */
export function splitDocs(
  changed: readonly string[],
  dirs: readonly string[],
): { docs: string[]; readersOnly: string[]; rest: string[] } {
  const docs: string[] = [];
  const readerFiles: string[] = [];
  const rest: string[] = [];
  for (const f of changed) {
    if (isProjectDoc(f, dirs)) docs.push(f);
    else if (readersOnly(f)) readerFiles.push(f);
    else rest.push(f);
  }
  return { docs, readersOnly: readerFiles, rest };
}

/**
 * What `vitest related` gets: the changed related sources, the subprocess
 * probe's consumer (`probeConsumers`), for a related source under a
 * `FIXTURE_CONSUMERS` path (the tree-sitter-mx corpus readers, say) the
 * tests in other projects that read it, the consumers of every readers-only
 * file (`readersOnly`: its readers run here instead of a whole project), and
 * `DOC_READERS` when any changed file is a corpus input (`CORPUS_INPUT`).
 * Deduped, in that order.
 */
export function relatedSources(changed: readonly string[]): string[] {
  const related = changed.filter(isRelatedSource);
  return [
    ...new Set([
      ...related,
      ...probeConsumers(changed),
      ...related.flatMap(fixtureConsumers),
      ...changed.filter((f) => readersOnly(f)).flatMap(fixtureConsumers),
      ...(changed.some((f) => CORPUS_INPUT.test(f)) ? DOC_READERS : []),
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
  // `onlyFiles: false` stays: Bun's globSync may honour it (Node ignores it).
  // A non-fresh object skips the excess-property check, so the call resolves
  // to the `string[]` overload; do not annotate it with Node's glob options.
  const options = { cwd: base, onlyFiles: false };
  return PROJECT_GLOBS.flatMap((g) => globSync(g, options))
    .map((d) => `${d.replace(/\/+$/, "")}/`)
    .filter((d) => existsSync(resolve(base, d)))
    .sort();
}

/** A file under a fixtures-style directory: tests read it through `fs`, never an import. */
export const FIXTURE_DIR = /(?:^|\/)(?:fixtures[^/]*|test-fixtures)\//;

const SOURCE_EXT = /\.[cm]?[jt]sx?$/;

/** A vitest/vite config: no test imports it, and vitest's default `forceRerunTriggers` does not match it as a related path. */
const CONFIG_FILE = /(?:^|\/)(?:vitest|vite)\.config\.[cm]?[jt]s$/;

/**
 * A file `vitest related` can see: a JS/TS source that is not under a
 * fixtures-style directory. `.mx` files and fixtures of any extension map to
 * their project instead — tests read them through the filesystem, so the
 * import graph would silently drop them (and a mixed change would stay green).
 * A vitest/vite config goes to its project too, and the root one goes to
 * `unmapped`.
 */
export function isRelatedSource(file: string): boolean {
  return (
    SOURCE_EXT.test(file) && !FIXTURE_DIR.test(file) && !CONFIG_FILE.test(file)
  );
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
    const name = m?.[1];
    if (name !== undefined) return name;
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

function git(args: string[], cwd = root): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/** The commit `HEAD` forked from `base`: what "changed" is measured against. */
function mergeBase(base = "origin/main"): string {
  return git(["merge-base", base, "HEAD"]).trim();
}

export function changedFiles(base = "origin/main"): string[] {
  return changedSince(mergeBase(base));
}

function changedSince(since: string): string[] {
  const names = new Set<string>();
  for (const out of [
    git(["diff", "--name-only", "--diff-filter=d", since]),
    git(["ls-files", "--others", "--exclude-standard"]),
  ]) {
    for (const line of out.split("\n")) if (line) names.add(line);
  }
  return [...names].filter((f) => existsSync(resolve(root, f))).sort();
}

/**
 * Comment text that can change a build, a type check, a lint or a test
 * environment (case-sensitive substrings). A comment that contains one is
 * load-bearing: adding, removing, editing or moving it is not comment-only.
 */
const COMMENT_MARKERS: readonly string[] = [
  "@ts-",
  "@jsx",
  "@vitest-environment",
  "@vite-ignore",
  "__PURE__",
  "__NO_SIDE_EFFECTS__",
  "biome-ignore",
  "eslint-",
  "prettier-ignore",
  "v8 ignore",
  "c8 ignore",
  "istanbul ignore",
  "<reference",
  "<amd-",
  "sourceMappingURL",
  "sourceURL",
  "webpack",
  "@license",
  "@preserve",
];

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const LINE_BREAK = /\r\n?|[\n\u2028\u2029]/g;

/**
 * What a comment-only edit leaves equal, as one string: the shebang line;
 * every leaf of the `getChildren` tree (JSDoc nodes skipped) as kind, text
 * (`JsxText` whole, leading spaces included) and whether a line break precedes
 * it; and every marker comment (`COMMENT_MARKERS`) as its text, the index of
 * the leaf it precedes and the line breaks between the two.
 */
function tokenSignature(fileName: string, text: string): string {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const leaves: [ts.SyntaxKind, string, boolean][] = [];
  const markers: [string, number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (
      node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode
    ) {
      return;
    }
    const children = node.getChildren(sf);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    // An empty list (`()`'s parameters, say) or a node a parse error left
    // missing has no text and no trivia of its own.
    if (node.pos === node.end && node.kind !== ts.SyntaxKind.EndOfFileToken) {
      leaves.push([node.kind, "", false]);
      return;
    }
    const start = node.getStart(sf);
    const leafText =
      node.kind === ts.SyntaxKind.JsxText
        ? text.slice(node.pos, node.end)
        : node.getText(sf);
    const trivia = text.slice(node.pos, start);
    const index = leaves.length;
    leaves.push([node.kind, leafText, /[\r\n\u2028\u2029]/.test(trivia)]);
    // Trailing ranges are the comments before the first line break, leading
    // ones the comments after it; at position 0 both return the same ranges.
    const ranges = new Map<number, ts.CommentRange>();
    for (const r of [
      ...(ts.getTrailingCommentRanges(text, node.pos) ?? []),
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
    ]) {
      ranges.set(r.pos, r);
    }
    for (const r of [...ranges.values()].sort((a, b) => a.pos - b.pos)) {
      const comment = text.slice(r.pos, r.end);
      if (!COMMENT_MARKERS.some((m) => comment.includes(m))) continue;
      const breaks = text.slice(r.end, start).match(LINE_BREAK)?.length ?? 0;
      markers.push([comment, index, breaks]);
    }
  };
  visit(sf);
  const shebang = text.startsWith("#!")
    ? (text.split(/\r\n?|[\n\u2028\u2029]/, 1)[0] ?? "")
    : "";
  return JSON.stringify([shebang, leaves, markers]);
}

/**
 * Whether `before` and `after` differ only in comments and same-line
 * whitespace: TypeScript parses both (the kind from `fileName`'s extension)
 * and their token signatures are equal. A line break added or removed between
 * two tokens (it can change ASI), a JSX text edit and any change to a marker
 * comment (`COMMENT_MARKERS`) are not comment-only; neither is a text the
 * parse throws on.
 */
export function commentOnly(
  fileName: string,
  before: string,
  after: string,
): boolean {
  try {
    return tokenSignature(fileName, before) === tokenSignature(fileName, after);
  } catch {
    return false;
  }
}

/**
 * Tests that read a source file's text (comments included), so a
 * comment-only edit to it can change their result. Each row lists every
 * consumer test file found reading a path the row matches. The
 * "SOURCE_TEXT_READERS guard" in `scripts/test-affected.test.ts` fails when a
 * test it detects reading a source a comment-only edit can leave out has no
 * row; it cannot see a path built in another module or passed through a
 * function parameter of an imported helper, so such a reader adds its row by
 * hand.
 */
export const SOURCE_TEXT_READERS: readonly {
  path: RegExp;
  consumers: readonly string[];
}[] = [
  {
    path: /^packages\/core\/src\/(?!(?:.*\/)?fixtures\/).*(?<!\.test)\.ts$/,
    consumers: [
      "packages/core/src/diagnostic-code-sites.test.ts",
      "packages/core/src/cold-start.test.ts",
      "packages/tooling/language-server/src/bundled-deps.test.ts",
      "packages/tooling/typescript-plugin/src/bundled-deps.test.ts",
      "packages/core/src/message-vocabulary-guard.test.ts",
    ],
  },
  {
    path: /^packages\/core\/src\/ir-entry\/index\.ts$/,
    consumers: ["packages/core/src/ir-entry/partial.test.ts"],
  },
  {
    path: /^packages\/parser\/src\/template\/.*\.ts$/,
    consumers: ["packages/parser/src/frontend/boundary.test.ts"],
  },
  {
    path: /^packages\/babel\/src\/mx-ast\.ts$/,
    consumers: [
      "packages/babel/src/mx-ast.test.ts",
      "packages/parser/src/mx-error-code.test.ts",
    ],
  },
  {
    path: /^packages\/hosts\/angular\/src\/runtime\.ts$/,
    consumers: ["packages/hosts/angular/test/runtime.test.ts"],
  },
  {
    path: /^packages\/editors\/vscode\/src\/extension\.ts$/,
    consumers: [
      "packages/editors/vscode/scripts/bundled-entries.test.ts",
      "packages/editors/vscode/src/manifest.test.ts",
    ],
  },
  {
    path: /^examples\/angular-app\//,
    consumers: ["packages/hosts/angular/test/example-app.test.ts"],
  },
];

/**
 * `changed` split into the files whose edit is comment-only (`commentOnly`;
 * only non-wide related sources that exist at the same path in the
 * merge-base, read by `before`) and the rest (`kept`), plus the deduped
 * `SOURCE_TEXT_READERS` consumers of the comment-only files (`readers`). Each
 * list keeps input order.
 */
export function commentOnlySplit(
  changed: readonly string[],
  before: (f: string) => string | undefined,
  after: (f: string) => string,
): { commentOnly: string[]; kept: string[]; readers: string[] } {
  const only: string[] = [];
  const kept: string[] = [];
  for (const f of changed) {
    const old = isRelatedSource(f) && !isWide(f) ? before(f) : undefined;
    (old !== undefined && commentOnly(f, old, after(f)) ? only : kept).push(f);
  }
  const readers = [
    ...new Set(
      only.flatMap((f) =>
        SOURCE_TEXT_READERS.filter((row) => row.path.test(f)).flatMap(
          (row) => row.consumers,
        ),
      ),
    ),
  ];
  return { commentOnly: only, kept, readers };
}

/**
 * A file vitest collects with its default `include`
 * (`configDefaults.include`, `**\/*.{test,spec}.?(c|m)[jt]s?(x)`). Project
 * configs that set `include` only narrow it, so this is a safe superset.
 */
export const VITEST_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Whether git (tracked plus untracked, not ignored) lists a vitest test file
 * under `dir`. Git, not a glob, so `node_modules`, `dist` and ignored dirs are
 * never walked.
 */
export function hasVitestTests(dir: string, base = root): boolean {
  return git(
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", dir],
    base,
  )
    .split("\n")
    .some((f) => VITEST_TEST_FILE.test(f));
}

/**
 * The project dirs owning a changed file that have no vitest tests
 * (`hasTests` false): distinct and sorted. A file outside every dir adds
 * nothing.
 */
export function ownRunnerDirs(
  files: readonly string[],
  dirs: readonly string[],
  hasTests: (dir: string) => boolean,
): string[] {
  const owners = new Set<string>();
  for (const f of files) {
    const d = ownerDir(f, dirs);
    if (d !== undefined) owners.add(d);
  }
  return [...owners].filter((d) => !hasTests(d)).sort();
}

/**
 * `--passWithNoTests` for the `vitest related` call: true only when there are
 * changed related sources and every one of them is owned by a dir in `own`
 * (no vitest test can be expected to import them), else false.
 */
export function relatedPassWithNoTests(
  changed: readonly string[],
  own: readonly string[],
  dirs: readonly string[],
): boolean {
  const related = changed.filter(isRelatedSource);
  return (
    related.length > 0 &&
    related.every((f) => {
      const d = ownerDir(f, dirs);
      return d !== undefined && own.includes(d);
    })
  );
}

/** `scripts.test` of `<dir>/package.json`, or undefined when there is none. */
export function testScript(dir: string, base = root): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(base, dir, "package.json"), "utf8"),
    );
    const t = pkg?.scripts?.test;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `--project` list without the own-runner projects (`own`), and one run
 * per own dir, in `own`'s order: its package's `test` script when it has one,
 * no `cmd` (named and skipped) otherwise.
 */
export function ownRunnerPlan(
  own: readonly string[],
  projects: readonly string[],
  script: (dir: string) => string | undefined = testScript,
  name: (dir: string) => string = projectName,
): {
  projects: string[];
  runs: { dir: string; name: string; cmd?: string[] }[];
} {
  const ownNames = new Set(own.map(name));
  return {
    projects: projects.filter((p) => !ownNames.has(p)),
    runs: own.map((dir) => ({
      dir,
      name: name(dir),
      ...(script(dir) === undefined
        ? {}
        : { cmd: ["bun", "run", "--cwd", dir, "test"] }),
    })),
  };
}

function run(cmd: string[], env: NodeJS.ProcessEnv): number {
  const [bin, ...args] = cmd;
  if (bin === undefined)
    throw new Error("test:affected: run() got an empty command");
  const r = spawnSync(bin, args, {
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

/**
 * The log line for a vitest command `main()` runs, printed in full so a log
 * shows every file the selection added (DOC_READERS, FIXTURE_CONSUMERS
 * consumers, PROBE_CONSUMER) and the trailing flags. With `lane`, the line
 * names the MX_TEST_LANE the command runs under.
 */
export function commandLog(cmd: readonly string[], lane?: string): string {
  const line = cmd.join(" ");
  return lane === undefined
    ? `test:affected: ${line}`
    : `test:affected: MX_TEST_LANE=${lane} ${line}`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const moon = argv.includes("--moon");
  const extra = argv.filter((a) => a !== "--moon");
  const base = mergeBase();
  const changed = changedSince(base);
  if (changed.length === 0) {
    console.log("test:affected: no changes vs origin/main; nothing to run.");
    return 0;
  }
  // A source whose tokens, line breaks and marker comments are unchanged
  // since the merge-base is left out; the tests that read its text still run.
  const split = commentOnlySplit(
    changed,
    (f) => {
      const r = spawnSync("git", ["show", `${base}:${f}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      return r.status === 0 ? r.stdout : undefined;
    },
    (f) => readFileSync(resolve(root, f), "utf8"),
  );
  const { kept, readers } = split;
  if (split.commentOnly.length > 0) {
    console.log(
      `test:affected: comment-only change (no token changed) -> not run: ${split.commentOnly.join(", ")}` +
        (readers.length > 0
          ? `; source-text readers via vitest related: ${readers.join(", ")}`
          : ""),
    );
  }
  if (kept.length === 0 && readers.length === 0) {
    console.log(
      "test:affected: only comment-only changes vs origin/main; nothing to run.",
    );
    return 0;
  }
  // Core's tests read the parser's dist; rebuild it when the change touches
  // one of its inputs. Under --moon, `core:test`'s `parser:build` dep does.
  if (!moon && parserBuildNeeded(changed)) {
    console.log(
      `test:affected: ${changed.find(isParserBuildInput)} is an input of packages/parser's dist -> bun run --cwd packages/parser build`,
    );
    const built = run(
      ["bun", "run", "--cwd", "packages/parser", "build"],
      process.env,
    );
    if (built !== 0) return built;
  }
  const dirs = projectDirs();
  // Project docs (.md) map to the Markdown readers only, never to their
  // owner's whole project or own test script.
  // Readers-only files (`readersOnly` rows) run only their rows' readers.
  const { docs, readersOnly: readerFiles, rest } = splitDocs(kept, dirs);
  if (docs.length > 0) {
    console.log(
      `test:affected: docs-only change -> no whole project (${docs.join(", ")}); Markdown readers via vitest related`,
    );
  }
  if (readerFiles.length > 0) {
    console.log(
      `test:affected: ${readerFiles.join(", ")} -> no whole project; their readers via vitest related`,
    );
  }
  const sources = [...new Set([...relatedSources(kept), ...readers])];
  const nonSources = rest.filter((f) => !isRelatedSource(f));
  const wide = kept.filter(isWide);
  if (wide.length > 0) {
    console.warn(
      `test:affected: ${wide.join(", ")} can affect tests the import graph does not show.\n` +
        "  Run the affected set, then let the gate (gate-auto.sh --packages ...) cover the rest.",
    );
  }
  const slowTouched = laneFor(kept);
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
  // Projects owning a changed file that have no vitest test files (the
  // tree-sitter grammars, Zed): vitest would fail them with "No test files
  // found", so they run their own `test` script or are named and skipped.
  const own = ownRunnerDirs(rest, dirs, (d) => hasVitestTests(d));

  if (sources.length > 0) {
    // passWithNoTests=false: a change whose sources no test imports must not
    // exit green (vitest 3 defaults `related` to passWithNoTests). It is true
    // only when every changed related source belongs to an own-runner
    // project, which is tested by its own script below; its sources stay in
    // the call so tests elsewhere that import them are still selected.
    const cmd = [
      "bunx",
      "vitest",
      "related",
      ...sources,
      "--run",
      `--passWithNoTests=${relatedPassWithNoTests(kept, own, dirs)}`,
      ...cacheArgs(process.env, extra),
      ...extra,
    ];
    console.log(commandLog(cmd, env.MX_TEST_LANE));
    rc = run(cmd, env);
  }

  // Changed files the import graph cannot see (.mx files, fixtures of any
  // extension, corpora, .json): run the vitest project of the package that
  // owns each one, plus the project of each test elsewhere that reads it.
  const { byProject, unmapped } = nonSourceProjects(nonSources, dirs);
  const plan = ownRunnerPlan(own, [...byProject.keys()]);
  if (plan.projects.length > 0) {
    for (const p of plan.projects) {
      console.log(
        `test:affected: non-source change -> whole project ${p} (${(byProject.get(p) ?? []).join(", ")})`,
      );
    }
    const cmd = [
      "bunx",
      "vitest",
      "run",
      ...plan.projects.flatMap((p) => ["--project", p]),
      "--passWithNoTests=false",
      ...extra,
    ];
    console.log(commandLog(cmd));
    rc = Math.max(rc, run(cmd, env));
  }
  if (unmapped.length > 0) {
    // Explicit, not silent: these changed files belong to no vitest project.
    console.log(
      `test:affected: no vitest project covers ${unmapped.join(", ")}; covered by the gate instead.`,
    );
  }

  // Own-runner projects. Extra args are vitest args, never passed here.
  for (const r of plan.runs) {
    if (r.cmd) {
      console.log(
        `test:affected: ${r.name} has no vitest tests -> bun run test in ${r.dir}`,
      );
      rc = Math.max(rc, run(r.cmd, env));
    } else {
      const files = kept.filter((f) => ownerDir(f, dirs) === r.dir);
      console.log(
        `test:affected: ${r.name} has no vitest tests and no test script (${files.join(", ")}); not run here, CI covers it.`,
      );
    }
  }

  return rc;
}

if (import.meta.main) process.exit(main());
