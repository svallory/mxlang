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
 * a source's text or run it in a subprocess (`SOURCE_TEXT_READERS`) run on
 * any change to a source a row matches, comment-only edits included: `relatedSources` adds them for a
 * kept source, `commentOnlySplit` for a left-out one. A file that is new,
 * renamed or untracked, a fixture, `.mx`, `.json`, `.md` or a wide file keeps
 * today's selection. The gate and CI run every test.
 *
 * A `package.json` outside fixtures-style dirs whose edit changes only
 * top-level metadata values (`MANIFEST_METADATA_KEYS`: `engines`,
 * `description`, `license`, ...; `manifestMetadataOnly`, `manifestSplit`)
 * runs only its `FIXTURE_CONSUMERS` readers through `vitest related`, never a
 * whole project, an own-runner `test` script or the wide-file warning. Any
 * other key changed, or a manifest that is new or does not parse, keeps
 * today's selection.
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
 * A workspace package that resolves through `dist/` (core, the parser's
 * Babel bundle, web-elements, tsx-bridge, the html target, host-angular,
 * vite-plugin, angular-checker, typescript-plugin) puts only its dist file in
 * its importers' import graphs, never its `src`. `DIST_PACKAGES` lists them
 * in rebuild order, with language-server and tsc (dists no test imports by
 * name, only reads or spawns), each with its `build` task's inputs, the dist
 * entries tests import, the earlier rows whose dist its bundle inlines and
 * the tests that read, load or spawn its dist by path (`readers`). A kept
 * change to a row's input (test files and fixtures excluded) first rebuilds
 * that dist and every dist that bundles it (`distBuilds`: `bun run --cwd
 * <dir> build`, in table order; under `--moon`, the `build` deps do), and a
 * JS/TS source among them that goes into a bundle also sends those rows'
 * entries to `vitest related` (`distEntries`), which then selects every test
 * whose import graph reaches one of those dists. The same JS/TS sources also
 * send those rows' `readers` (`distReaders`), which no import graph shows.
 * Through a bundle every such test depends on every bundled module, so any
 * token edit to a bundled source of core, web-elements, tsx-bridge or the
 * Babel fork selects close to the whole suite.
 */
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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

/** A workspace package whose tests' importers resolve it through `dist/`. */
export interface DistPackage {
  /** Workspace-relative package dir. */
  dir: string;
  /** Its `build` task's inputs in `<dir>/moon.yml`. */
  inputs: readonly RegExp[];
  /** The dist files tests import by name (passed to `vitest related`). */
  entries: readonly string[];
  /** Dirs of EARLIER rows whose dist this package's bundle inlines. */
  bundles: readonly string[];
  /**
   * The test files that read, load or spawn THIS row's dist by path
   * (`readFileSync`, `statSync`, a computed `import()` or `createRequire`, a
   * spawned `dist/bin.*`), or through a subprocess that resolves the package
   * by name (a source a `SOURCE_TEXT_READERS` row spawns, or one it imports,
   * that loads this package by name is listed here): the dist version of
   * `SOURCE_TEXT_READERS`. Their import graphs
   * hold no dist file, so `vitest related` would not select them from the
   * entries. A reader of a dist that this dist loads at run time (an
   * external) is not listed here. The "dist readers guard" in
   * `scripts/test-affected.test.ts` fails on a detected dist path read with
   * no entry here; it cannot see a path built in a helper module or inside a
   * function body, a template path or a package-name resolution in a
   * subprocess, so such a reader is listed by hand.
   */
  readers: readonly string[];
}

/** Packs each real package and checks its packed dist JS: a reader of every row but the parser. */
const PACK_HYGIENE = "scripts/pack-hygiene.test.ts";

/** Files shared by most rows' `build` inputs: the lockfile and the base tsconfig. */
const ROOT_INPUTS: readonly RegExp[] = [
  /^bun\.lock$/,
  /^tsconfig\.base\.json$/,
];

/** The notices script and the Babel fork's license files the bundles copy. */
const NOTICE_INPUTS: readonly RegExp[] = [
  /^scripts\/third-party-notices\.ts$/,
  /^packages\/babel\/LICENSE$/,
  /^packages\/babel\/UPSTREAM\.md$/,
];

/**
 * The workspace dists tests import by name, read or spawn, in rebuild order
 * (the root `build` script's order). language-server and tsc have no entries:
 * no test imports them by name, only their `readers` reach them. The VS Code
 * extension's dist has no row (no test reads it). Keep each row's inputs in
 * step with `build`'s inputs in <dir>/moon.yml.
 */
export const DIST_PACKAGES: readonly DistPackage[] = [
  {
    dir: "packages/parser",
    inputs: [
      /^packages\/parser\/src\/frontend\/babel\.ts$/,
      /^packages\/babel\/src\//,
      /^packages\/babel\/package\.json$/,
      /^packages\/parser\/package\.json$/,
      /^packages\/parser\/tsconfig\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: ["packages/parser/dist/babel.js"],
    bundles: [],
    readers: [],
  },
  {
    dir: "packages/web-elements",
    inputs: [
      /^packages\/web-elements\/src\//,
      /^packages\/web-elements\/tsconfig\.json$/,
      /^packages\/web-elements\/tsconfig\.build\.json$/,
      /^packages\/web-elements\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: ["packages/web-elements/dist/index.js"],
    bundles: [],
    readers: [
      "packages/target-registry/src/bundle-smoke.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/core",
    inputs: [
      /^packages\/core\/src\//,
      /^packages\/core\/build\//,
      /^packages\/parser\/src\//,
      /^packages\/parser\/package\.json$/,
      /^packages\/babel\/src\//,
      /^packages\/babel\/package\.json$/,
      ...NOTICE_INPUTS,
      /^packages\/core\/tsconfig\.json$/,
      /^packages\/core\/tsconfig\.build\.json$/,
      /^packages\/core\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: ["packages/core/dist/index.js"],
    bundles: ["packages/web-elements"],
    readers: [
      "packages/core/src/cold-start.test.ts",
      "packages/tooling/tsc/src/third-party-target.test.ts",
      "packages/hosts/solid/src/index.test.ts",
      "packages/hosts/angular/test/body-whitespace.test.ts",
      "packages/hosts/angular/test/bound-refinement-render.test.ts",
      "packages/hosts/angular/test/primitive-attributes.test.ts",
      "packages/oracle/src/attribute-value.test.ts",
      "packages/oracle/src/primitive-attributes.test.ts",
      "packages/oracle/src/textarea-value.test.ts",
      "packages/targets/html/src/attribute-value.test.ts",
      "packages/targets/html/src/primitive-attributes.test.ts",
      "packages/target-registry/src/light-import.test.ts",
      "packages/oracle/src/custom-tags.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/tsx-bridge",
    inputs: [
      /^packages\/tsx-bridge\/src\//,
      /^packages\/babel\/src\//,
      /^packages\/tsx-bridge\/scripts\/emit-declarations\.ts$/,
      ...NOTICE_INPUTS,
      /^packages\/tsx-bridge\/package\.json$/,
      /^packages\/tsx-bridge\/tsconfig\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: ["packages/tsx-bridge/dist/index.js"],
    bundles: [],
    readers: [
      "packages/tsx-bridge/src/vendored.test.ts",
      "packages/tsx-bridge/src/pack-contents.test.ts",
      "packages/hosts/angular/test/body-whitespace.test.ts",
      "packages/hosts/angular/test/bound-refinement-render.test.ts",
      "packages/hosts/angular/test/primitive-attributes.test.ts",
      "packages/oracle/src/attribute-value.test.ts",
      "packages/oracle/src/primitive-attributes.test.ts",
      "packages/oracle/src/textarea-value.test.ts",
      "packages/targets/html/src/attribute-value.test.ts",
      "packages/targets/html/src/primitive-attributes.test.ts",
      "packages/oracle/src/custom-tags.test.ts",
      "packages/target-registry/src/bundle-smoke.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/targets/html",
    inputs: [
      /^packages\/targets\/html\/src\//,
      /^packages\/targets\/html\/tsconfig\.json$/,
      /^packages\/targets\/html\/tsconfig\.build\.json$/,
      /^packages\/targets\/html\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: [
      "packages/targets/html/dist/index.js",
      "packages/targets/html/dist/descriptor.js",
      "packages/targets/html/dist/runtime.js",
    ],
    bundles: [],
    readers: [
      "packages/targets/html/src/stock-parser.test.ts",
      "packages/target-registry/src/parity.test.ts",
      "packages/target-registry/src/light-import.test.ts",
      "packages/oracle/src/custom-tags.test.ts",
      "packages/targets/html/src/helpers.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/hosts/angular",
    inputs: [
      /^packages\/hosts\/angular\/src\//,
      ...NOTICE_INPUTS,
      /^packages\/hosts\/angular\/tsconfig\.json$/,
      /^packages\/hosts\/angular\/tsconfig\.build\.json$/,
      /^packages\/hosts\/angular\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: [
      "packages/hosts/angular/dist/index.js",
      "packages/hosts/angular/dist/descriptor.js",
    ],
    bundles: ["packages/tsx-bridge"],
    readers: [
      "packages/hosts/angular/test/runtime.test.ts",
      "packages/target-registry/src/parity.test.ts",
      "packages/target-registry/src/light-import.test.ts",
      "packages/tooling/tsc/src/angular-fix-hints.test.ts",
      "packages/tooling/angular-checker/src/worker.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/tooling/vite-plugin",
    inputs: [
      /^packages\/tooling\/vite-plugin\/src\//,
      /^packages\/tooling\/vite-plugin\/build\//,
      /^scripts\/bundled-build\.ts$/,
      /^scripts\/baked-paths\.ts$/,
      ...NOTICE_INPUTS,
      /^packages\/target-registry\/src\//,
      /^packages\/hosts\/[^/]+\/src\//,
      /^packages\/targets\/[^/]+\/src\//,
      /^packages\/core\/src\//,
      /^packages\/tsx-bridge\/src\//,
      /^packages\/babel\/src\//,
      /^packages\/tooling\/vite-plugin\/tsconfig\.json$/,
      /^packages\/tooling\/vite-plugin\/tsconfig\.build\.json$/,
      /^packages\/tooling\/vite-plugin\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: ["packages/tooling/vite-plugin/dist/index.js"],
    bundles: [
      "packages/web-elements",
      "packages/targets/html",
      "packages/hosts/angular",
    ],
    readers: [
      "packages/tooling/vite-plugin/src/dist-dispatch.test.ts",
      "packages/tooling/vite-plugin/src/light-import.test.ts",
      "packages/oracle/src/attribute-value.test.ts",
      "packages/oracle/src/primitive-attributes.test.ts",
      "packages/oracle/src/textarea-value.test.ts",
      "packages/targets/html/src/attribute-value.test.ts",
      "packages/targets/html/src/primitive-attributes.test.ts",
      "packages/hosts/angular/test/primitive-attributes.test.ts",
      "packages/target-registry/src/light-import.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/tooling/language-server",
    inputs: [
      /^packages\/tooling\/language-server\/src\//,
      /^packages\/target-registry\/src\//,
      /^packages\/hosts\/[^/]+\/src\//,
      /^packages\/babel\/src\//,
      ...NOTICE_INPUTS,
      /^packages\/tooling\/language-server\/tsconfig\.json$/,
      /^packages\/tooling\/language-server\/tsconfig\.build\.json$/,
      /^packages\/tooling\/language-server\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: [],
    bundles: [
      "packages/web-elements",
      "packages/targets/html",
      "packages/hosts/angular",
    ],
    readers: [
      "packages/tooling/language-server/src/server.test.ts",
      "packages/tooling/language-server/src/contracts.test.ts",
      "packages/tooling/language-server/src/dialect-contracts.test.ts",
      "packages/tooling/language-server/src/dialect-lower-options.test.ts",
      "packages/tooling/language-server/src/dist-build.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/tooling/angular-checker",
    inputs: [
      /^packages\/tooling\/angular-checker\/src\//,
      /^packages\/tooling\/angular-checker\/tsconfig\.json$/,
      /^packages\/tooling\/angular-checker\/tsconfig\.build\.json$/,
      /^packages\/tooling\/angular-checker\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: ["packages/tooling/angular-checker/dist/index.js"],
    bundles: [],
    readers: [
      "packages/tooling/angular-checker/src/dist.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/tooling/typescript-plugin",
    inputs: [
      /^packages\/tooling\/typescript-plugin\/src\//,
      /^packages\/tooling\/typescript-plugin\/build\//,
      /^packages\/target-registry\/src\//,
      /^packages\/hosts\/[^/]+\/src\//,
      /^scripts\/bundled-build\.ts$/,
      /^scripts\/baked-paths\.ts$/,
      ...NOTICE_INPUTS,
      /^packages\/tooling\/typescript-plugin\/tsconfig\.json$/,
      /^packages\/tooling\/typescript-plugin\/tsconfig\.build\.json$/,
      /^packages\/tooling\/typescript-plugin\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: ["packages/tooling/typescript-plugin/dist/index.cjs"],
    bundles: [
      "packages/web-elements",
      "packages/targets/html",
      "packages/hosts/angular",
      "packages/tooling/angular-checker",
    ],
    readers: [
      "packages/tooling/typescript-plugin/src/cjs-factory.test.ts",
      "packages/tooling/typescript-plugin/src/dist-dispatch.test.ts",
      "packages/tooling/typescript-plugin/src/ng-worker-bundle.test.ts",
      "packages/tooling/typescript-plugin/src/strip-ng-declarations.test.ts",
      "packages/tooling/typescript-plugin/src/tsconfig-paths-callee.test.ts",
      "packages/tooling/typescript-plugin/src/tsserver-load.test.ts",
      PACK_HYGIENE,
    ],
  },
  {
    dir: "packages/tooling/tsc",
    inputs: [
      /^packages\/tooling\/tsc\/src\//,
      /^scripts\/bundled-build\.ts$/,
      /^scripts\/baked-paths\.ts$/,
      ...NOTICE_INPUTS,
      /^packages\/tooling\/tsc\/tsconfig\.json$/,
      /^packages\/tooling\/tsc\/package\.json$/,
      ...ROOT_INPUTS,
    ],
    entries: [],
    bundles: [],
    readers: [
      "packages/tooling/tsc/src/build-cache-build.test.ts",
      "packages/tooling/tsc/src/build-uptodate.test.ts",
      "packages/tooling/tsc/src/build-uptodate-modes.test.ts",
      "packages/tooling/tsc/src/bun-runtime.test.ts",
      "packages/tooling/tsc/src/contracts.test.ts",
      "packages/tooling/tsc/src/host-policy-diagnostics.test.ts",
      "packages/tooling/tsc/src/watch.test.ts",
      "packages/tooling/tsc/src/watch-ambient-types.test.ts",
      "packages/tooling/tsc/src/watch-rebuild-diagnostics.test.ts",
      "packages/hosts/hono/src/try-typecheck.test.ts",
      PACK_HYGIENE,
    ],
  },
];

/**
 * Inputs that only write notice files or `.d.ts`: they rebuild their rows'
 * dists but select no dist importers.
 */
const BUILD_ONLY_INPUTS: readonly RegExp[] = [
  /^scripts\/third-party-notices\.ts$/,
  /^packages\/tsx-bridge\/scripts\/emit-declarations\.ts$/,
];

/** A file that can change `row`'s dist: one of its inputs, not a test file, not a fixture. */
function isDistInput(row: DistPackage, file: string): boolean {
  return (
    row.inputs.some((re) => re.test(file)) &&
    !VITEST_TEST_FILE.test(file) &&
    !FIXTURE_DIR.test(file)
  );
}

/**
 * The rows of `table` marked by `direct` (a row's own test of the change) or
 * by a row named in its `bundles`, in table order. One pass is enough because
 * `bundles` names only earlier rows.
 */
function cascade(
  table: readonly DistPackage[],
  direct: (row: DistPackage) => boolean,
): DistPackage[] {
  const marked = new Set<string>();
  const out: DistPackage[] = [];
  for (const row of table) {
    if (direct(row) || row.bundles.some((d) => marked.has(d))) {
      marked.add(row.dir);
      out.push(row);
    }
  }
  return out;
}

/**
 * The dists `main()` must rebuild, in rebuild order: a row whose inputs a
 * changed file matches (test files and fixtures excluded, they are never
 * bundled), and every row that bundles a rebuilt one.
 */
export function distBuilds(
  files: readonly string[],
  table: readonly DistPackage[] = DIST_PACKAGES,
): DistPackage[] {
  return cascade(table, (row) => files.some((f) => isDistInput(row, f)));
}

/**
 * The dist entries `vitest related` must get to reach the tests that import
 * those packages by name (their importers' graphs hold the dist file, never
 * the package's `src`): a row with a changed JS/TS input that goes into the
 * bundle, and every row that bundles one, flattened in table order. A
 * manifest, tsconfig, lockfile, license file or `BUILD_ONLY_INPUTS` script
 * rebuilds its rows (`distBuilds`) but selects nothing.
 */
export function distEntries(
  files: readonly string[],
  table: readonly DistPackage[] = DIST_PACKAGES,
): string[] {
  return selectingRows(files, table).flatMap((row) => row.entries);
}

/**
 * The `readers` of the same rows `distEntries` selects (a changed JS/TS input
 * that goes into the bundle, and every row that bundles one), flattened in
 * table order and deduped: the tests that read, load or spawn those dists by path, which
 * no import graph reaches. A manifest, tsconfig, lockfile, license file or
 * `BUILD_ONLY_INPUTS` script rebuilds its rows but adds no reader.
 */
export function distReaders(
  files: readonly string[],
  table: readonly DistPackage[] = DIST_PACKAGES,
): string[] {
  return [
    ...new Set(selectingRows(files, table).flatMap((row) => row.readers)),
  ];
}

/** A changed file that selects its rows' entries and readers: a JS/TS input that goes into the bundle. */
function selecting(file: string): boolean {
  return (
    isRelatedSource(file) && !BUILD_ONLY_INPUTS.some((re) => re.test(file))
  );
}

/** The rows a `selecting` change reaches, directly or through `bundles`, in table order. */
function selectingRows(
  files: readonly string[],
  table: readonly DistPackage[],
): DistPackage[] {
  return cascade(table, (row) =>
    files.some((f) => selecting(f) && isDistInput(row, f)),
  );
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
 *
 * A manifest row (`isManifest`) also lists the manifest's same-project
 * readers: a metadata-only manifest edit (`manifestSplit`) runs only its
 * rows' consumers, never its owner's project, so the guard treats a manifest
 * as having no owner too.
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
    consumers: [
      "packages/editors/vscode/src/manifest.test.ts",
      "packages/target-registry/src/parity.test.ts",
    ],
  },
  {
    path: /^packages\/hosts\/angular\/package\.json$/,
    consumers: ["packages/hosts/angular/test/runtime.test.ts"],
  },
  {
    path: /^packages\/parser\/package\.json$/,
    consumers: ["packages/parser/src/frontend/boundary.test.ts"],
  },
  {
    path: /^packages\/target-registry\/package\.json$/,
    consumers: ["packages/target-registry/src/umbrella.test.ts"],
  },
  {
    path: /^packages\/tooling\/angular-checker\/package\.json$/,
    consumers: ["packages/tooling/angular-checker/src/dist.test.ts"],
  },
  {
    path: /^packages\/tsx-bridge\/package\.json$/,
    consumers: ["packages/tsx-bridge/src/pack-contents.test.ts"],
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
 * What `vitest related` gets: the changed related sources, for each related
 * source the tests in other projects that read it as a `FIXTURE_CONSUMERS`
 * path (the tree-sitter-mx corpus readers, say) followed by the tests that
 * read its text or run it in a subprocess (`SOURCE_TEXT_READERS`; they run on
 * any change to a source a row matches, and `commentOnlySplit` adds them for
 * a comment-only edit, which never reaches here), the consumers of every
 * readers-only file (`readersOnly`: its readers run here instead of a whole
 * project), and `DOC_READERS` when any changed file is a corpus input
 * (`CORPUS_INPUT`), the dist entries of every `DIST_PACKAGES` row a changed
 * source goes into, directly or through a bundled row (`distEntries`: their
 * importers reach them through that dist, never through the package's
 * `src`), and the `readers` of those same rows (`distReaders`: tests that
 * read, load or spawn the dist by path, which no import graph shows).
 * Deduped, in that order.
 */
export function relatedSources(changed: readonly string[]): string[] {
  const related = changed.filter(isRelatedSource);
  return [
    ...new Set([
      ...related,
      ...related.flatMap((f) => [
        ...fixtureConsumers(f),
        ...sourceTextReaders(f),
      ]),
      ...changed.filter((f) => readersOnly(f)).flatMap(fixtureConsumers),
      ...(changed.some((f) => CORPUS_INPUT.test(f)) ? DOC_READERS : []),
      ...distEntries(changed),
      ...distReaders(changed),
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
 * The non-test, non-fixture `src` files of the package dirs `dirs`, plus the
 * exact repo-relative paths `files`, as one row path (the core row's
 * lookarounds). A spawned script's closure that enters a package's `src`
 * matches that whole `src`.
 */
function spawnedPath(
  files: readonly string[],
  dirs: readonly string[] = [],
): RegExp {
  const quote = (p: string) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const alternatives = files.map(quote);
  if (dirs.length > 0) {
    alternatives.push(
      `(?:${dirs.map(quote).join("|")})\\/src\\/(?!(?:.*\\/)?fixtures\\/).*(?<!\\.test)\\.tsx?`,
    );
  }
  return new RegExp(`^(?:${alternatives.join("|")})$`);
}

/** The hosts whose `exports` resolve to `src` and that the probe and the registry load. */
const SRC_HOSTS = [
  "packages/hosts/preact",
  "packages/hosts/react",
  "packages/hosts/hono",
  "packages/hosts/solid",
  "packages/hosts/astro",
];

/**
 * Tests that read a source file's text (comments included), or run it in a
 * subprocess (spawn it, or spawn a script that imports it), rather than
 * importing it, so `vitest related` cannot select them. They run on any
 * change to a source a row matches: `relatedSources` adds them for a source
 * whose edit changes a token, `commentOnlySplit` for a comment-only edit.
 * Each row lists every consumer test file found reading a path the row
 * matches. A spawned script's row matches the script and its value-import
 * closure: a package whose `exports` resolve to `src` is followed into its
 * whole `src` (`spawnedPath`), a `DIST_PACKAGES` package is not (its row's
 * `readers` lists the test). The "SOURCE_TEXT_READERS guard" in
 * `scripts/test-affected.test.ts` fails when a test it detects reading such a
 * source has no row and no exemption; it cannot see a path built in another
 * module or passed through a function parameter of an imported helper, so
 * such a reader adds its row by hand. The "spawned sources guard" there
 * fails on a detected spawn of a source with no row; it checks only the
 * spawned entry and cannot see a template path, a generated script, a spread
 * argument, a cwd-relative string, a script in a fixtures dir, a path handed
 * to a helper or a spawn inside a non-test module, so those rows (the
 * upstream parser suite, the registry's light-import and bundle-smoke, the
 * oracle's custom tags, the two checker workers, stock-marko's runner) are
 * listed by hand, and so is each closure.
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
    consumers: [
      "packages/parser/src/frontend/boundary.test.ts",
      // Runs `node --test src/template/__tests__/*.test.ts`, which import ../index.ts and ../internal.ts.
      "packages/parser/src/template/upstream-suite.test.ts",
    ],
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
  {
    path: /^packages\/tsx-bridge\/src\/public\.d\.ts$/,
    consumers: ["packages/tsx-bridge/src/pack-contents.test.ts"],
  },
  // A: the angular fixture scripts the tests spawn with `bun run`; they import angular's src.
  {
    path: spawnedPath(
      [
        "packages/hosts/angular/test/body-whitespace-fixture.ts",
        "packages/hosts/angular/test/bound-refinement-fixture.ts",
        "packages/hosts/angular/test/primitive-attribute-fixture.ts",
        "packages/hosts/angular/test/primitive-attribute-rescued.ts",
      ],
      ["packages/hosts/angular"],
    ),
    consumers: [
      "packages/hosts/angular/test/body-whitespace.test.ts",
      "packages/hosts/angular/test/bound-refinement-render.test.ts",
      "packages/hosts/angular/test/primitive-attributes.test.ts",
    ],
  },
  // P: the attribute-value probe renders the html target and each src host.
  {
    path: spawnedPath(
      ["scripts/attribute-value-probe.ts"],
      ["packages/targets/html", ...SRC_HOSTS],
    ),
    consumers: [
      "packages/oracle/src/attribute-value.test.ts",
      "packages/oracle/src/primitive-attributes.test.ts",
      "packages/oracle/src/textarea-value.test.ts",
      "packages/targets/html/src/attribute-value.test.ts",
      "packages/targets/html/src/primitive-attributes.test.ts",
      "packages/hosts/angular/test/primitive-attributes.test.ts",
    ],
  },
  // R: a generated probe imports the registry, which imports each host's `/descriptor` by name.
  {
    path: spawnedPath([], ["packages/target-registry", ...SRC_HOSTS]),
    consumers: ["packages/target-registry/src/light-import.test.ts"],
  },
  // L: spawned as `loader`; it value-imports only resolve-after-miss.ts and target-descriptor.ts.
  {
    path: /^packages\/core\/src\/(?:target-loader|resolve-after-miss|target-descriptor)\.ts$/,
    consumers: ["packages/core/src/target-loader-resolve.test.ts"],
  },
  // O: fixtures-custom-tags/run.ts imports normalize-html.ts and the src hosts by name.
  {
    path: spawnedPath(
      ["packages/oracle/src/normalize-html.ts"],
      [
        "packages/hosts/hono",
        "packages/hosts/preact",
        "packages/hosts/react",
        "packages/hosts/solid",
      ],
    ),
    consumers: ["packages/oracle/src/custom-tags.test.ts"],
  },
  // B: `bun build` of each host's src entries (`HOST_BUILDS`).
  {
    path: spawnedPath(
      [],
      [
        "packages/targets/html",
        "packages/hosts/hono",
        "packages/hosts/react",
        "packages/hosts/preact",
        "packages/hosts/solid",
      ],
    ),
    consumers: ["packages/target-registry/src/bundle-smoke.test.ts"],
  },
  // W: worker-client.ts forks worker-main.ts, passed as `workerPath`.
  {
    path: spawnedPath([], ["packages/tooling/angular-checker"]),
    consumers: ["packages/tooling/angular-checker/src/worker.test.ts"],
  },
  // N: passed as `workerPath`; it imports only @mxlang/angular-checker (dist).
  {
    path: /^packages\/tooling\/typescript-plugin\/src\/ng-worker\.ts$/,
    consumers: [
      "packages/tooling/typescript-plugin/src/ng-editor-path.test.ts",
    ],
  },
  // M: marko.ts's `run()` spawns it with process.execPath.
  {
    path: /^packages\/stock-marko\/src\/run-stock-marko\.cjs$/,
    consumers: [
      "packages/stock-marko/src/marko.test.ts",
      "packages/stock-marko/src/divergence.test.ts",
    ],
  },
];

/** The tests that read `file`'s text (`SOURCE_TEXT_READERS`), in row order, not deduplicated. */
export function sourceTextReaders(file: string): string[] {
  return SOURCE_TEXT_READERS.filter((row) => row.path.test(file)).flatMap(
    (row) => row.consumers,
  );
}

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
  const readers = [...new Set(only.flatMap(sourceTextReaders))];
  return { commentOnly: only, kept, readers };
}

/**
 * Top-level manifest keys that no test, build or module resolution reads in
 * this repository. A test that reads one is a `FIXTURE_CONSUMERS` row of that
 * manifest and still runs on a metadata-only edit.
 */
const MANIFEST_METADATA_KEYS: readonly string[] = [
  "engines",
  "description",
  "keywords",
  "author",
  "license",
  "repository",
  "homepage",
  "bugs",
  "funding",
];

/** A `package.json` outside fixtures-style dirs: the root and every workspace manifest. */
export function isManifest(file: string): boolean {
  return basename(file) === "package.json" && !FIXTURE_DIR.test(file);
}

/** `text` parsed as a plain JSON object, or undefined. */
function manifestObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a manifest edit changes only `MANIFEST_METADATA_KEYS`: both texts
 * parse to plain objects and every top-level key on either side whose values
 * differ (an added or removed key included) is a metadata key. A change of
 * whitespace or key order only is metadata-only; a parse error or a
 * non-object on either side is not. Never throws.
 */
export function manifestMetadataOnly(before: string, after: string): boolean {
  const a = manifestObject(before);
  const b = manifestObject(after);
  if (a === undefined || b === undefined) return false;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
    (k) => MANIFEST_METADATA_KEYS.includes(k) || isDeepStrictEqual(a[k], b[k]),
  );
}

/**
 * `changed` split into the manifests whose edit is metadata-only
 * (`isManifest`, present at the same path in the merge-base, read by
 * `before`, and `manifestMetadataOnly`) and the rest (`kept`), plus the
 * deduped `FIXTURE_CONSUMERS` consumers of the metadata-only manifests
 * (`readers`). Each list keeps input order.
 */
export function manifestSplit(
  changed: readonly string[],
  before: (f: string) => string | undefined,
  after: (f: string) => string,
): { metadataOnly: string[]; kept: string[]; readers: string[] } {
  const only: string[] = [];
  const kept: string[] = [];
  for (const f of changed) {
    const old = isManifest(f) ? before(f) : undefined;
    (old !== undefined && manifestMetadataOnly(old, after(f))
      ? only
      : kept
    ).push(f);
  }
  const readers = [...new Set(only.flatMap((f) => fixtureConsumers(f)))];
  return { metadataOnly: only, kept, readers };
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
 * consumers, SOURCE_TEXT_READERS consumers) and the trailing flags. With `lane`, the line
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
  const before = (f: string): string | undefined => {
    const r = spawnSync("git", ["show", `${base}:${f}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return r.status === 0 ? r.stdout : undefined;
  };
  const after = (f: string) => readFileSync(resolve(root, f), "utf8");
  const split = commentOnlySplit(changed, before, after);
  if (split.commentOnly.length > 0) {
    console.log(
      `test:affected: comment-only change (no token changed) -> not run: ${split.commentOnly.join(", ")}` +
        (split.readers.length > 0
          ? `; source-text readers via vitest related: ${split.readers.join(", ")}`
          : ""),
    );
  }
  // A manifest whose edit changes only metadata keys runs only its readers.
  const manifests = manifestSplit(split.kept, before, after);
  if (manifests.metadataOnly.length > 0) {
    console.log(
      `test:affected: metadata-only manifest change (${MANIFEST_METADATA_KEYS.join(", ")}) -> no whole project: ${manifests.metadataOnly.join(", ")}` +
        (manifests.readers.length > 0
          ? `; their readers via vitest related: ${manifests.readers.join(", ")}`
          : ""),
    );
  }
  const { kept } = manifests;
  const readers = [...new Set([...split.readers, ...manifests.readers])];
  if (kept.length === 0 && readers.length === 0) {
    console.log(
      "test:affected: only comment-only or metadata-only changes vs origin/main; nothing to run.",
    );
    return 0;
  }
  // Tests import these packages through their dists; rebuild every dist a
  // kept change reaches, directly or through a bundled dist, in rebuild order.
  // Under --moon, each test task's `build` deps do.
  if (!moon) {
    const rebuilt = new Set<string>();
    for (const row of distBuilds(kept)) {
      const input = kept.find((f) => isDistInput(row, f));
      const inner = row.bundles.find((d) => rebuilt.has(d));
      console.log(
        input !== undefined
          ? `test:affected: ${input} is an input of ${row.dir}'s dist -> bun run --cwd ${row.dir} build`
          : `test:affected: ${row.dir} bundles ${inner}'s dist -> bun run --cwd ${row.dir} build`,
      );
      const built = run(["bun", "run", "--cwd", row.dir, "build"], process.env);
      if (built !== 0) return built;
      rebuilt.add(row.dir);
    }
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
