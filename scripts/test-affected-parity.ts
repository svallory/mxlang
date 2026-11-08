#!/usr/bin/env bun
/**
 * Native-parity verifier for the `test:affected` selection cache
 * (scripts/test-affected-cache.ts). `bun run test:affected:parity`; a step of
 * `bun run verify`.
 *
 * The cache serves import lists so `vitest related` can skip its ~15 s of
 * serial transforms. A stale list silently drops a covering test and a green
 * run cannot show it, so this script proves, on every run, that the cache
 * and native agree. Two halves run in parallel:
 *
 * 1. `real`: on this repository, with a fresh private store, the dependency
 *    set of every discovered test from a cold run (every module goes through
 *    native, so this is native's answer) must equal the set the warm run
 *    serves from the store. Then, for a sample of files, the tests the warm
 *    run selects as related must equal the ones the cold sets imply.
 * 2. `rows`: on a small fixture project, one mutation per guard (glob
 *    addition, config define, unaudited plugin and version, file
 *    add/delete/rename, symlink, manifest, content edit, store corruption,
 *    concurrent runs, relocation). Every row warms the store, then
 *    *poisons* it (rewrites each stored import list to empty, with a valid
 *    checksum), applies the mutation, and selects through the cache and
 *    natively. Poison is what makes a removed guard visible: a guard that
 *    works never serves a poisoned entry, so the cached selection equals
 *    native's; without the guard the poisoned (empty) list is served and the
 *    covering test is dropped. A control row shows the poison is live: with
 *    no mutation the cache must serve it and so must disagree with native.
 *
 * The cache is forced on here (`CI` and `MX_AFFECTED_NATIVE` are cleared in
 * this process only) because a verifier that inherited "cache off" would
 * compare native with native.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createVitest } from "vitest/node";
import {
  collectInputs,
  type Inputs,
  namespaceFor,
  SCHEMA_VERSION,
  Store,
} from "./test-affected-cache.ts";
import AffectedCacheReporter from "./test-affected-cache-reporter.ts";

/** Processes the real-repository half is split across. */
const SHARDS = 4;

const repoRoot = resolve(import.meta.dirname, "..");

// --------------------------------------------------------------- harness

/**
 * The reporter reports through `console.log`. Concurrent selections cannot
 * each swap and restore it (the last restore would reinstate another's
 * capture and swallow all later output), so one router is installed once and
 * fans lines out to the sinks of the selections in flight.
 */
const realLog = console.log.bind(console);
const sinks = new Set<string[]>();
console.log = (...a: unknown[]) => {
  if (sinks.size === 0) realLog(...a);
  for (const sink of sinks) sink.push(a.join(" "));
};

interface Fx {
  /** fixture project root (a git repository) */
  root: string;
  /** selection store, inside the fixture so a copy carries it */
  store: string;
}

interface SelectOptions {
  related: string[];
  cached: boolean;
  define?: Record<string, string>;
  /** extra vite plugins (the project config is otherwise bare) */
  plugins?: unknown[];
  /** rewrite the namespace inputs the reporter gathered */
  inputs?: (i: Inputs) => Inputs;
  /** vitest `server` options (for example `deps.inline`) */
  server?: unknown;
  /** use these exact namespace inputs instead of gathering them */
  pinned?: Inputs;
}

interface Selection {
  files: string[];
  line: string;
}

const gather = (root: string, projects: Inputs["projects"]): Inputs =>
  collectInputs(
    root,
    projects,
    process.env,
    realpathSync(join(root, "node_modules", "vitest")),
  );

/** Forced-on environment for this process (see the header). */
function forceCacheOn(): void {
  process.env.MX_AFFECTED_CACHE = "1";
  delete process.env.CI;
  delete process.env.MX_AFFECTED_NATIVE;
  process.env.MX_VITEST_QUIET = "1";
}

/** Select tests related to `o.related`, through the reporter or natively. */
async function select(fx: Fx, o: SelectOptions): Promise<Selection> {
  const reporter = new AffectedCacheReporter({
    dir: fx.store,
    inputs: (root, projects) =>
      o.pinned
        ? { ...o.pinned, root, projects }
        : (o.inputs ?? ((i) => i))(gather(root, projects)),
  });
  const lines: string[] = [];
  sinks.add(lines);
  const exitCode = process.exitCode;
  try {
    const ctx = await createVitest(
      "test",
      {
        root: fx.root,
        config: false,
        watch: false,
        run: true,
        globals: true,
        related: o.related.map((f) => join(fx.root, f)),
        reporters: o.cached ? [reporter] : [],
        define: o.define,
        server: o.server as never,
      },
      { plugins: o.plugins as never },
      { stdout: process.stderr },
    );
    try {
      await ctx.init();
      const specs = await ctx.getRelevantTestSpecifications();
      reporter.onTestRunStart();
      return {
        files: specs.map((s) => relative(fx.root, s.moduleId)).sort(),
        line: lines.join("\n"),
      };
    } finally {
      await ctx.close();
    }
  } finally {
    sinks.delete(lines);
    process.exitCode = exitCode;
  }
}

/** Every stored entry file of the fixture's store. */
function storeFiles(store: string): { ns: string; file: string }[] {
  const out: { ns: string; file: string }[] = [];
  const versionDir = join(store, `v${SCHEMA_VERSION}`);
  if (!existsSync(versionDir)) return out;
  for (const ns of readdirSync(versionDir)) {
    for (const shard of readdirSync(join(versionDir, ns))) {
      if (shard === ".used") continue;
      for (const f of readdirSync(join(versionDir, ns, shard))) {
        if (f.endsWith(".json")) {
          out.push({ ns, file: join(versionDir, ns, shard, f) });
        }
      }
    }
  }
  return out;
}

type Poison = "empty-lists" | "stale-checksum" | "garbage";

/** Damage every stored entry; returns how many were damaged. */
function poison(store: string, how: Poison): number {
  const files = storeFiles(store);
  for (const { ns, file } of files) {
    const p = JSON.parse(readFileSync(file, "utf8"));
    if (how === "empty-lists") {
      // A *valid* entry claiming the module imports nothing.
      new Store(store, ns).put(p.key, { deps: [], dynamicDeps: [] });
    } else if (how === "stale-checksum") {
      writeFileSync(file, JSON.stringify({ ...p, deps: [], dynamicDeps: [] }));
    } else {
      writeFileSync(file, '{"schema":1,"key":');
    }
  }
  return files.length;
}

const write = (fx: Fx, rel: string, text: string) => {
  mkdirSync(join(fx.root, rel, ".."), { recursive: true });
  writeFileSync(join(fx.root, rel), text);
};

const git = (root: string, ...args: string[]) => {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=parity",
      "-c",
      "user.email=parity@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

const TEST = (name: string, imports: string) =>
  `${imports}\nit(${JSON.stringify(name)}, () => {});\n`;

/** The baseline project every row starts from (a committed git repository). */
function buildBaseline(root: string): void {
  const w = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w(".gitignore", "node_modules/\n.store/\n");
  w(
    "package.json",
    JSON.stringify({
      name: "parity-fx",
      type: "module",
      imports: { "#target": "./src/target-a.ts" },
    }),
  );
  w("src/lib.ts", "export const lib = 1;\n");
  w("src/other.ts", "export const other = 1;\n");
  w("src/edited.ts", "export const edited = 1;\n");
  w("src/target-a.ts", "export const t = 'a';\n");
  w("src/target-b.ts", "export const t = 'b';\n");
  w("src/addme.ts", "export const addme = 'ts';\n");
  w("src/dup.js", "export const dup = 'js';\n");
  w("src/dup.ts", "export const dup = 'ts';\n");
  w("src/ren.js", "export const ren = 1;\n");
  w("cases/a.ts", "export const value = 1;\n");
  w("real-1/x.ts", "export const x = 1;\n");
  w("real-2/x.ts", "export const x = 2;\n");
  w("tree-1/y.ts", "export const y = 1;\n");
  w("tree-2/y.ts", "export const y = 2;\n");
  w("lib.test.ts", TEST("lib", 'import "./src/lib.ts";'));
  w("edit.test.ts", TEST("edit", 'import "./src/lib.ts";'));
  w("plugin.test.ts", TEST("plugin", 'import "./src/other.ts";'));
  w("manifest.test.ts", TEST("manifest", 'import "#target";'));
  w("add.test.ts", TEST("add", 'import "./src/addme";'));
  w("dup.test.ts", TEST("dup", 'import "./src/dup";'));
  w("ren.test.ts", TEST("ren", 'import "./src/ren";'));
  w("link.test.ts", TEST("link", 'import "link/x.ts";'));
  w("tree.test.ts", TEST("tree", 'import "./src/tree/y.ts";'));
  w(
    "glob.test.ts",
    'it("glob", () => {});\nexport const modules = import.meta.glob("./cases/*.ts");\n',
  );
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(
    realpathSync(join(repoRoot, "node_modules", "vitest")),
    join(root, "node_modules", "vitest"),
  );
  symlinkSync("../real-1", join(root, "node_modules", "link"));
  symlinkSync("../tree-1", join(root, "src", "tree"));
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "baseline");
}

// ------------------------------------------------------------------ rows

interface Row {
  name: string;
  /** the guard this row exercises */
  guard: string;
  /** warm the store under these options before poisoning */
  warm?: Partial<SelectOptions>;
  poison?: Poison;
  /** the guard may leave the store empty (nothing stored, nothing to poison) */
  poisonOptional?: boolean;
  /** change the fixture (and return a different fixture to select in) */
  // biome-ignore lint/suspicious/noConfusingVoidType: most rows return nothing
  mutate?: (fx: Fx) => Fx | void;
  /** options for the post-mutation selections (cached and native) */
  after?: Partial<SelectOptions>;
  /** keep the namespace inputs fixed across the mutation (isolates a guard) */
  pin?: boolean;
  related: string;
  /** native's selection after the mutation */
  expect: string[];
  /** the control: the cache must serve the poison, so it must disagree */
  diverges?: boolean;
  /** replaces the generic flow */
  custom?: (fx: Fx, copy: () => Fx) => Promise<string[]>;
}

/** A test-only plugin whose output depends on the run, not on the source. */
const injecting = (on: boolean) => ({
  name: "parity-inject",
  enforce: "pre",
  transform(code: string, id: string) {
    if (on && id.endsWith("plugin.test.ts")) {
      return `${code}\nimport "./src/lib.ts";\n`;
    }
  },
});

export const ROWS: Row[] = [
  {
    name: "control: unmutated poison is served",
    guard:
      "the poison itself (a verifier that cannot see staleness is vacuous)",
    poison: "empty-lists",
    related: "src/lib.ts",
    expect: ["edit.test.ts", "lib.test.ts"],
    diverges: true,
  },
  {
    name: "glob addition",
    guard: "bypassReason: glob import sources are never cached",
    pin: true,
    mutate: (fx) => write(fx, "cases/b.ts", "export const value = 2;\n"),
    related: "cases/b.ts",
    expect: ["glob.test.ts"],
  },
  {
    name: "config define",
    guard: "projectKey: resolved config (define) is part of every entry key",
    poison: "empty-lists",
    after: { define: { __PARITY__: '"2"' } },
    related: "src/lib.ts",
    expect: ["edit.test.ts", "lib.test.ts"],
  },
  {
    name: "plugin behaviour changes under a stable name",
    guard: "projectKey: a plugin outside the audited list bypasses the project",
    warm: { plugins: [injecting(false)] },
    poison: "empty-lists",
    poisonOptional: true,
    after: { plugins: [injecting(true)] },
    related: "src/lib.ts",
    expect: ["edit.test.ts", "lib.test.ts", "plugin.test.ts"],
  },
  {
    name: "unaudited tool version",
    guard: "namespaceFor: only the audited vitest/vite/vite-node versions",
    warm: {
      inputs: (i) => ({ ...i, versions: { ...i.versions, vite: "0.0.0" } }),
    },
    poison: "empty-lists",
    // With the guard the warm run stores nothing, so there is nothing to
    // poison; without it the poison is served and the row fails.
    poisonOptional: true,
    after: {
      inputs: (i) => ({ ...i, versions: { ...i.versions, vite: "0.0.0" } }),
    },
    related: "src/lib.ts",
    expect: ["edit.test.ts", "lib.test.ts"],
  },
  {
    name: "content edit",
    guard: "entryKey: the file's content hash",
    poison: "empty-lists",
    mutate: (fx) =>
      write(fx, "edit.test.ts", TEST("edit", 'import "./src/edited.ts";')),
    related: "src/edited.ts",
    expect: ["edit.test.ts"],
  },
  {
    name: "file added (shadows a resolution)",
    guard: "inventory: the repository file list is part of the namespace",
    poison: "empty-lists",
    mutate: (fx) => write(fx, "src/addme.js", "export const addme = 'js';\n"),
    related: "src/addme.js",
    expect: ["add.test.ts"],
  },
  {
    name: "tracked file deleted from the working tree",
    guard: "inventory: a deleted tracked file leaves the list",
    poison: "empty-lists",
    mutate: (fx) => unlinkSync(join(fx.root, "src/dup.js")),
    related: "src/dup.ts",
    expect: ["dup.test.ts"],
  },
  {
    name: "file renamed",
    guard: "inventory: a rename changes the list",
    poison: "empty-lists",
    mutate: (fx) =>
      renameSync(join(fx.root, "src/ren.js"), join(fx.root, "src/ren.mjs")),
    related: "src/ren.mjs",
    expect: ["ren.test.ts"],
  },
  {
    name: "node_modules symlink retargeted",
    guard: "packages: top-level symlink targets are part of the namespace",
    related: "real-2/x.ts",
    expect: [],
    // Selection never follows a node_modules link (those are externalised and
    // skipped by vitest's graph walk), so the effect is not visible in the
    // selected names: assert the namespace itself moves.
    custom: async (fx) => {
      const ns = () => {
        const r = namespaceFor(gather(fx.root, []));
        return r.ok ? r.value : `native: ${r.reason}`;
      };
      const before = ns();
      const link = join(fx.root, "node_modules", "link");
      unlinkSync(link);
      symlinkSync("../real-2", link);
      return before === ns()
        ? ["retargeting node_modules/link left the namespace unchanged"]
        : [];
    },
  },
  {
    name: "tracked in-tree symlink retargeted",
    guard: "inventory: symlinks in the working tree are followed by targets",
    poison: "empty-lists",
    mutate: (fx) => {
      const link = join(fx.root, "src", "tree");
      unlinkSync(link);
      symlinkSync("../tree-2", link);
    },
    related: "tree-2/y.ts",
    expect: ["tree.test.ts"],
  },
  {
    name: "manifest edited (package.json imports)",
    guard: "manifests: package.json content is part of the namespace",
    poison: "empty-lists",
    mutate: (fx) =>
      write(
        fx,
        "package.json",
        JSON.stringify({
          name: "parity-fx",
          type: "module",
          imports: { "#target": "./src/target-b.ts" },
        }),
      ),
    related: "src/target-b.ts",
    expect: ["manifest.test.ts"],
  },
  {
    name: "entry corrupted: unparseable",
    guard: "Store.get: a parse failure is a miss",
    poison: "garbage",
    related: "src/lib.ts",
    expect: ["edit.test.ts", "lib.test.ts"],
  },
  {
    name: "entry corrupted: stale checksum",
    guard: "Store.get: the integrity checksum",
    poison: "stale-checksum",
    related: "src/lib.ts",
    expect: ["edit.test.ts", "lib.test.ts"],
  },
  {
    name: "project relocated",
    guard: "namespace and entry key include the project root",
    poison: "empty-lists",
    mutate: (fx) => {
      const root = mkdtempSync(join(tmpdir(), "mx-parity-moved-"));
      cpSync(fx.root, root, { recursive: true, verbatimSymlinks: true });
      rmSync(fx.root, { recursive: true, force: true });
      return {
        root: realpathSync(root),
        store: join(realpathSync(root), ".store"),
      };
    },
    related: "src/lib.ts",
    expect: ["edit.test.ts", "lib.test.ts"],
  },
  {
    name: "concurrent cold runs",
    guard:
      "Store.put: atomic publish, so concurrent writers never corrupt an entry",
    related: "src/lib.ts",
    expect: ["edit.test.ts", "lib.test.ts"],
    custom: async (fx) => {
      const problems: string[] = [];
      const runs = await Promise.all(
        [0, 1, 2, 3].map(() =>
          select(fx, { related: ["src/lib.ts"], cached: true }),
        ),
      );
      for (const r of runs) {
        if (r.files.join() !== "edit.test.ts,lib.test.ts") {
          problems.push(`a concurrent run selected ${r.files.join(",")}`);
        }
      }
      const files = storeFiles(fx.store);
      if (files.length === 0) problems.push("no entry was stored");
      for (const { ns, file } of files) {
        const p = JSON.parse(readFileSync(file, "utf8"));
        if (!new Store(fx.store, ns).get(p.key)) {
          problems.push(`entry ${file} fails its own checksum`);
        }
      }
      const leftovers = readdirSync(fx.store, { recursive: true }).filter((f) =>
        String(f).endsWith(".tmp"),
      );
      if (leftovers.length > 0) {
        problems.push(`leftover temp files: ${leftovers.join(",")}`);
      }
      const warm = await select(fx, { related: ["src/lib.ts"], cached: true });
      if (!/[1-9]\d* hits/.test(warm.line)) {
        problems.push(`no cache hits after concurrent writes: ${warm.line}`);
      }
      return problems;
    },
  },
];

/** One row against its own copy of the baseline; returns the problems. */
async function runRow(row: Row, baseline: string): Promise<string[]> {
  const make = (): Fx => {
    const root = mkdtempSync(join(tmpdir(), "mx-parity-row-"));
    cpSync(baseline, root, { recursive: true, verbatimSymlinks: true });
    const real = realpathSync(root);
    return { root: real, store: join(real, ".store") };
  };
  let fx = make();
  try {
    if (row.custom) return await row.custom(fx, make);
    const related = [row.related];
    const warm = await select(fx, {
      related: ["src/lib.ts"],
      cached: true,
      ...row.warm,
    });
    const problems: string[] = [];
    if (
      storeFiles(fx.store).length === 0 &&
      row.poison &&
      !row.poisonOptional
    ) {
      problems.push(`warm run stored nothing (${warm.line})`);
    }
    let pinned: Inputs | undefined;
    if (row.pin) {
      pinned = gather(
        fx.root,
        // the projects are re-supplied by the reporter; only the rest is fixed
        [],
      );
    }
    if (
      row.poison &&
      poison(fx.store, row.poison) === 0 &&
      !row.poisonOptional
    ) {
      problems.push("nothing to poison");
    }
    fx = row.mutate?.(fx) ?? fx;
    const opts = { related, ...row.after, pinned };
    const cached = await select(fx, { ...opts, cached: true });
    const native = await select(fx, { ...opts, cached: false });
    if (native.files.join() !== row.expect.join()) {
      problems.push(
        `row is vacuous: native selected [${native.files}], expected [${row.expect}]`,
      );
    }
    const same = cached.files.join() === native.files.join();
    if (row.diverges) {
      if (same) problems.push("control: the cache did not serve the poison");
    } else if (!same) {
      problems.push(
        `cached selected [${cached.files}] but native selected [${native.files}] (${cached.line})`,
      );
    }
    return problems;
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

export interface RowResult {
  row: Row;
  problems: string[];
}

/** Run the mutation rows; `only` filters by row name. */
export async function runRows(
  only?: (r: Row) => boolean,
): Promise<RowResult[]> {
  forceCacheOn();
  const baseline = realpathSync(mkdtempSync(join(tmpdir(), "mx-parity-base-")));
  try {
    buildBaseline(baseline);
    const out: RowResult[] = [];
    for (const row of ROWS.filter(only ?? (() => true))) {
      let problems: string[];
      try {
        problems = await runRow(row, baseline);
      } catch (e) {
        problems = [`threw: ${(e as Error).stack ?? e}`];
      }
      out.push({ row, problems });
    }
    return out;
  } finally {
    rmSync(baseline, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- real repo

type DepMap = Map<string, string[]>;

/** Dependency set of every discovered test of this repository. */
async function realDeps(
  store: string,
  shard: [number, number],
  samples?: string[],
): Promise<{ deps: DepMap; line: string; sampled: Map<string, string[]> }> {
  const reporter = new AffectedCacheReporter({ dir: store });
  const lines: string[] = [];
  sinks.add(lines);
  const exitCode = process.exitCode;
  try {
    const ctx = await createVitest(
      "test",
      { root: repoRoot, watch: false, run: true, reporters: [reporter] },
      {},
      { stdout: process.stderr },
    );
    try {
      await ctx.init();
      // biome-ignore lint/suspicious/noExplicitAny: vitest's specification API is internal
      const all = (await (ctx as any).globTestSpecifications()) as {
        moduleId: string;
        project: { name: string };
      }[];
      // Whole projects per shard (greedy by size): a project's modules are
      // transformed by its own server, so splitting a project would repeat
      // its shared imports in every shard.
      const byProject = new Map<string, typeof all>();
      for (const sp of all) {
        byProject.set(sp.project.name, [
          ...(byProject.get(sp.project.name) ?? []),
          sp,
        ]);
      }
      const load = Array.from({ length: shard[1] }, () => 0);
      const mine: typeof all = [];
      for (const [, list] of [...byProject].sort(
        (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
      )) {
        const k = load.indexOf(Math.min(...load));
        load[k] += list.length;
        if (k === shard[0]) mine.push(...list);
      }
      const specs = mine;
      const deps: DepMap = new Map();
      for (const spec of specs) {
        // biome-ignore lint/suspicious/noExplicitAny: internal
        const set = (await (ctx as any).specifications.getTestDependencies(
          spec,
        )) as Set<string>;
        deps.set(
          `${spec.project.name} ${relative(repoRoot, spec.moduleId)}`,
          [...set].sort(),
        );
      }
      const sampled = new Map<string, string[]>();
      for (const f of samples ?? []) {
        ctx.config.related = [f];
        // biome-ignore lint/suspicious/noExplicitAny: internal
        const chosen = (await (ctx as any).specifications.filterTestsBySource(
          specs,
        )) as {
          moduleId: string;
          project: { name: string };
        }[];
        sampled.set(
          f,
          chosen
            .map((s) => `${s.project.name} ${relative(repoRoot, s.moduleId)}`)
            .sort(),
        );
      }
      reporter.onTestRunStart();
      return { deps, line: lines.join("\n"), sampled };
    } finally {
      await ctx.close();
    }
  } finally {
    sinks.delete(lines);
    process.exitCode = exitCode;
  }
}

/**
 * Cold-vs-warm dependency parity over one shard of this repository's tests
 * (`shard` = [index, count]; the shards together cover every test) against a
 * store shared by the shards.
 */
export async function runReal(
  store: string,
  shard: [number, number],
): Promise<string[]> {
  forceCacheOn();
  // Every lane: the slow files are tests too.
  process.env.MX_TEST_LANE = "all";
  const problems: string[] = [];
  try {
    // Cold: the store is empty, so every module is transformed natively.
    const t0 = performance.now();
    const cold = await realDeps(store, shard);
    const t1 = performance.now();
    if (!/ 0 hits/.test(cold.line)) {
      problems.push(`cold run was not cold: ${cold.line}`);
    }
    const universe = new Set<string>();
    for (const d of cold.deps.values()) for (const f of d) universe.add(f);
    const all = [...universe].filter((f) => !f.includes("node_modules")).sort();
    const samples = all.filter((_, i) => i % Math.ceil(all.length / 4) === 0);
    const warm = await realDeps(store, shard, samples);
    console.log(
      `real timing: cold ${Math.round(t1 - t0)} ms, warm ${Math.round(performance.now() - t1)} ms`,
    );
    if (!/[1-9]\d* hits/.test(warm.line)) {
      problems.push(`warm run served nothing: ${warm.line}`);
    }
    if (cold.deps.size === 0) problems.push("no tests were discovered");
    if (warm.deps.size !== cold.deps.size) {
      problems.push(
        `discovered ${cold.deps.size} tests cold but ${warm.deps.size} warm`,
      );
    }
    for (const [test, want] of cold.deps) {
      const got = warm.deps.get(test);
      if (got?.join("\n") !== want.join("\n")) {
        const miss = want.filter((f) => !got?.includes(f));
        const extra = (got ?? []).filter((f) => !want.includes(f));
        problems.push(
          `${test}: cached deps differ from native (missing ${miss.length}, extra ${extra.length}; e.g. ${[...miss, ...extra][0]})`,
        );
      }
    }
    for (const [f, got] of warm.sampled) {
      const want = [...cold.deps]
        .filter(
          ([test, d]) =>
            d.includes(f) || test.endsWith(` ${relative(repoRoot, f)}`),
        )
        .map(([test]) => test)
        .sort();
      if (want.join("\n") !== got.join("\n")) {
        problems.push(
          `edit of ${relative(repoRoot, f)}: cached selects [${got}] but native selects [${want}]`,
        );
      }
    }
    console.log(
      `real: ${cold.deps.size} tests, ${all.length} files, ${samples.length} sampled edits; warm ${warm.line.split("\n").pop()}`,
    );
  } finally {
  }
  return problems;
}

// ------------------------------------------------------------------ main

async function part(which: "real" | "rows", argv: string[]): Promise<number> {
  let bad = 0;
  if (which === "real") {
    const arg = (n: string) => argv[argv.indexOf(n) + 1];
    const [i, n] = arg("--shard").split("/").map(Number);
    const problems = await runReal(arg("--store"), [i, n]);
    for (const p of problems) console.log(`FAIL real ${i + 1}/${n}: ${p}`);
    console.log(
      `${problems.length ? "FAIL" : "PASS"} real shard ${i + 1}/${n}`,
    );
    return problems.length ? 1 : 0;
  }
  const results = await runRows();
  for (const { row, problems } of results) {
    if (problems.length === 0) console.log(`PASS row: ${row.name}`);
    else {
      bad++;
      console.log(`FAIL row: ${row.name}  [guard: ${row.guard}]`);
      for (const p of problems) console.log(`  ${p}`);
    }
  }
  return bad ? 1 : 0;
}

function child(
  which: "real" | "rows",
  extra: string[] = [],
): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const c = spawn(
      process.execPath,
      [import.meta.filename, "--part", which, ...extra],
      {
        cwd: repoRoot,
        env: process.env,
      },
    );
    let out = "";
    c.stdout.on("data", (d) => {
      out += d;
    });
    c.stderr.on("data", (d) => {
      out += d;
    });
    c.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--part");
  if (i >= 0) return part(argv[i + 1] as "real" | "rows", argv);
  const started = performance.now();
  // The shards share one private store; the cold pass is the expensive one
  // (native transforms), so splitting it across processes keeps the verifier
  // inside its time budget.
  const store = mkdtempSync(join(tmpdir(), "mx-parity-store-"));
  let parts: { code: number; out: string }[];
  try {
    parts = await Promise.all([
      child("rows"),
      ...Array.from({ length: SHARDS }, (_, k) =>
        child("real", ["--store", store, "--shard", `${k}/${SHARDS}`]),
      ),
    ]);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
  for (const p of parts) process.stdout.write(p.out);
  const failed = parts.some((p) => p.code !== 0);
  console.log(
    `test:affected:parity ${failed ? "FAILED" : "passed"} in ${Math.round((performance.now() - started) / 1000)} s`,
  );
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
