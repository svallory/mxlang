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
 * The cache is forced on while a half runs (`CI` and `MX_AFFECTED_NATIVE` are
 * cleared, then restored) because a verifier that inherited "cache off" would
 * compare native with native.
 *
 * The rows also run in vitest (scripts/test-affected-parity.test.ts, so a
 * change that touches this file selects them), which means `bun run verify`
 * runs them twice, a few seconds. That is accepted: the verifier stays
 * runnable on its own, and the real-repository half runs only here, in the
 * local gate (CI runs the vitest rows, not this script).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createVitest } from "vitest/node";
import { projectDirs, projectFor } from "./test-affected.ts";
import {
  collectInputs,
  type Inputs,
  namespaceFor,
  SCHEMA_VERSION,
  Store,
} from "./test-affected-cache.ts";
import AffectedCacheReporter from "./test-affected-cache-reporter.ts";

/** Longest a child may run before it is killed and reported. */
const CHILD_TIMEOUT_MS = 120_000;

/** Processes the real-repository half is split across. */
const SHARDS = 4;

const repoRoot = resolve(import.meta.dirname, "..");

// --------------------------------------------------------------- harness

/**
 * The reporter reports through `console.log` and explains a native fallback
 * through `console.warn`; capture both for one selection. Returns the restore
 * function.
 */
function capture(lines: string[]): () => void {
  const log = console.log;
  const warn = console.warn;
  const push = (...a: unknown[]) => {
    lines.push(a.join(" "));
  };
  console.log = push;
  console.warn = push;
  return () => {
    console.log = log;
    console.warn = warn;
  };
}

const ENV_KEYS = [
  "MX_AFFECTED_CACHE",
  "CI",
  "MX_AFFECTED_NATIVE",
  "MX_VITEST_QUIET",
  "MX_TEST_LANE",
] as const;

/**
 * Run `fn` with the cache forced on (see the header) and the environment put
 * back afterwards, so importing this module from a test leaves no trace.
 */
async function withHarness<T>(
  extra: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  process.env.MX_AFFECTED_CACHE = "1";
  delete process.env.CI;
  delete process.env.MX_AFFECTED_NATIVE;
  process.env.MX_VITEST_QUIET = "1";
  Object.assign(process.env, extra);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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
  /** content of a vitest config file to run with (written into the fixture) */
  configText?: string;
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
  const restore = capture(lines);
  const exitCode = process.exitCode;
  try {
    let config: string | false = false;
    if (o.configText !== undefined) {
      config = join(fx.root, "parity.config.mts");
      writeFileSync(config, o.configText);
    }
    const ctx = await createVitest(
      "test",
      {
        root: fx.root,
        config,
        watch: false,
        run: true,
        globals: true,
        related: o.related.map((f) => (isAbsolute(f) ? f : join(fx.root, f))),
        reporters: o.cached ? [reporter] : [],
        define: o.define,
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
    restore();
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
  w(".gitignore", "node_modules/\n.store/\n.hammer/\n.ignored/\n");
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
  w("pkg.test.ts", TEST("pkg", 'import "./package.json";'));
  w("src/swap.ts", "export const swap = 'inside';\n");
  w("swap.test.ts", TEST("swap", 'import "./src/swap.ts";'));
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

interface RowBase {
  name: string;
  /** the guard this row exercises */
  guard: string;
}

/** The generic flow: warm, poison, mutate, select cached and natively. */
interface FlowRow extends RowBase {
  custom?: undefined;
  /** prepare the fixture before the warm run */
  setup?: (fx: Fx) => void;
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
  /** the edited file: fixture-relative, or absolute (computed from the fixture) */
  related: string | ((fx: Fx) => string);
  /** native's selection after the mutation */
  expect: string[];
  /** the control: the cache must serve the poison, so it must disagree */
  diverges?: boolean;
}

/** A row with its own flow. */
interface CustomRow extends RowBase {
  custom: (fx: Fx) => Promise<string[]>;
}

type Row = FlowRow | CustomRow;

const ALL_TESTS = [
  "add.test.ts",
  "dup.test.ts",
  "edit.test.ts",
  "glob.test.ts",
  "lib.test.ts",
  "link.test.ts",
  "manifest.test.ts",
  "pkg.test.ts",
  "plugin.test.ts",
  "ren.test.ts",
  "swap.test.ts",
  "tree.test.ts",
];

const CONFIG_WITH = (value: string) =>
  `export default { test: { globals: true }, define: { __PARITY_CFG__: ${JSON.stringify(value)} } };\n`;

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
    name: "related file is a force-rerun trigger",
    guard:
      "none: pins the verifier's model of native for sampled edits (vitest returns every test for a package.json edit)",
    related: "package.json",
    expect: ALL_TESTS,
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
    name: "config-file define",
    guard:
      "projectKey: the resolved defines (a config file's simple defines land there, not in the vite config)",
    warm: { configText: CONFIG_WITH('"1"') },
    poison: "empty-lists",
    after: { configText: CONFIG_WITH('"2"') },
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
    name: "symlink to a directory outside the repository",
    guard:
      "inventory: a link leaving the repository makes selection native (its target's files are not in the list)",
    // The link and the directory behind it are created per row: a link out of
    // the repository would make every other row native.
    setup: (fx) => {
      const ext = `${fx.root}-ext`;
      mkdirSync(ext, { recursive: true });
      writeFileSync(join(ext, "z.ts"), "export const z = 'ts';\n");
      symlinkSync(ext, join(fx.root, "src", "ext"));
      write(fx, "ext.test.ts", TEST("ext", 'import "./src/ext/z";'));
    },
    poison: "empty-lists",
    // With the guard the warm run stores nothing, so there is nothing to poison.
    poisonOptional: true,
    mutate: (fx) =>
      writeFileSync(
        join(readlinkSync(join(fx.root, "src", "ext")), "z.js"),
        "export const z = 'js';\n",
      ),
    related: (fx) => join(readlinkSync(join(fx.root, "src", "ext")), "z.js"),
    expect: ["ext.test.ts"],
  },
  {
    name: "tracked file replaced by a symlink out of the repository",
    guard:
      "inventory: an unstaged typechange is a symlink candidate, and a link out of the repository makes selection native",
    poison: "empty-lists",
    mutate: (fx) => {
      const ext = `${fx.root}-ext`;
      mkdirSync(ext, { recursive: true });
      writeFileSync(join(ext, "swap.ts"), "export const swap = 'outside';\n");
      unlinkSync(join(fx.root, "src", "swap.ts"));
      symlinkSync(join(ext, "swap.ts"), join(fx.root, "src", "swap.ts"));
    },
    related: (fx) => join(`${fx.root}-ext`, "swap.ts"),
    expect: ["swap.test.ts"],
  },
  {
    name: "symlink to a gitignored directory inside the repository",
    guard:
      "inventory: a link whose target has no file in the list makes selection native",
    setup: (fx) => {
      const dir = join(fx.root, ".ignored", "ign");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "z.ts"), "export const z = 'ts';\n");
      symlinkSync("../.ignored/ign", join(fx.root, "src", "ign"));
      write(fx, "ign.test.ts", TEST("ign", 'import "./src/ign/z";'));
    },
    poison: "empty-lists",
    poisonOptional: true,
    mutate: (fx) =>
      writeFileSync(
        join(fx.root, ".ignored", "ign", "z.js"),
        "export const z = 'js';\n",
      ),
    related: (fx) => join(fx.root, ".ignored", "ign", "z.js"),
    expect: ["ign.test.ts"],
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
    guard:
      "the project root is in the namespace, entry key, project key and symlink paths (redundant: all four must go to fail)",
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
    name: "concurrent runs in separate processes",
    guard:
      "Store.put: atomic publish, so a concurrent reader never sees a torn entry",
    // Two writers hammer one large entry while two readers poll it, and four
    // cold selections share the fixture store, all as separate processes. A
    // put that writes straight to the final path is seen torn by a reader.
    custom: async (fx) => {
      const problems: string[] = [];
      const hammer = join(fx.root, ".hammer");
      const done = join(hammer, "done");
      mkdirSync(hammer, { recursive: true });
      const readers = [0, 1].map(() =>
        spawnPart(
          [
            "--part",
            "hammer",
            "--role",
            "read",
            "--store",
            hammer,
            "--done",
            done,
          ],
          "READY",
        ),
      );
      await Promise.all(readers.map((r) => r.ready));
      const busy = [
        ...[0, 1].map(() =>
          spawnPart([
            "--part",
            "hammer",
            "--role",
            "write",
            "--store",
            hammer,
            "--done",
            done,
          ]),
        ),
        ...[0, 1, 2, 3].map(() =>
          spawnPart([
            "--part",
            "select",
            "--root",
            fx.root,
            "--store",
            fx.store,
            "--related",
            "src/lib.ts",
          ]),
        ),
      ];
      const results = await Promise.all(busy.map((p) => p.exit));
      writeFileSync(done, "");
      const readerResults = await Promise.all(readers.map((r) => r.exit));
      for (const r of results.slice(0, 2)) {
        if (r.code !== 0)
          problems.push(`a writer failed: ${r.out.slice(-300)}`);
      }
      for (const r of results.slice(2)) {
        const m = /^RESULT (.*)$/m.exec(r.out);
        const files = m ? (JSON.parse(m[1]) as Selection).files : undefined;
        if (files?.join() !== "edit.test.ts,lib.test.ts") {
          problems.push(
            `a concurrent run selected [${files}]: ${r.out.slice(-300)}`,
          );
        }
      }
      for (const r of readerResults) {
        const m = /^RESULT (.*)$/m.exec(r.out);
        const got = m
          ? (JSON.parse(m[1]) as { reads: number; torn: number })
          : undefined;
        if (!got || got.reads === 0)
          problems.push(`a reader read nothing: ${r.out.slice(-300)}`);
        else if (got.torn > 0)
          problems.push(
            `a reader saw ${got.torn} torn entries in ${got.reads} reads`,
          );
      }
      const files = storeFiles(fx.store);
      if (files.length === 0) problems.push("no entry was stored");
      for (const { ns, file } of files) {
        const p = JSON.parse(readFileSync(file, "utf8"));
        if (!new Store(fx.store, ns).get(p.key)) {
          problems.push(`entry ${file} fails its own checksum`);
        }
      }
      const leftovers = readdirSync(fx.root, { recursive: true }).filter((f) =>
        String(f).endsWith(".tmp"),
      );
      if (leftovers.length > 0) {
        problems.push(`leftover temp files: ${leftovers.join(",")}`);
      }
      // A child again, not this process: vitest sets variables of its own in
      // the process that creates it, and the cache key includes some of them.
      const warm = await spawnPart([
        "--part",
        "select",
        "--root",
        fx.root,
        "--store",
        fx.store,
        "--related",
        "src/lib.ts",
      ]).exit;
      const line = /^RESULT (.*)$/m.exec(warm.out);
      const warmLine = line
        ? (JSON.parse(line[1]) as Selection).line
        : warm.out;
      if (!/[1-9]\d* hits/.test(warmLine)) {
        problems.push(`no cache hits after concurrent writes: ${warmLine}`);
      }
      return problems;
    },
  },
];

/** One row against its own copy of the baseline; returns the problems. */
async function runRow(row: Row, baseline: string): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "mx-parity-row-"));
  cpSync(baseline, root, { recursive: true, verbatimSymlinks: true });
  const real = realpathSync(root);
  let fx: Fx = { root: real, store: join(real, ".store") };
  const ext = `${fx.root}-ext`;
  try {
    if (row.custom) return await row.custom(fx);
    row.setup?.(fx);
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
      // the projects are re-supplied by the reporter; only the rest is fixed
      pinned = gather(fx.root, []);
    }
    if (
      row.poison &&
      poison(fx.store, row.poison) === 0 &&
      !row.poisonOptional
    ) {
      problems.push("nothing to poison");
    }
    const related =
      typeof row.related === "function" ? row.related(fx) : row.related;
    fx = row.mutate?.(fx) ?? fx;
    const opts = { related: [related], ...row.after, pinned };
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
    rmSync(real, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
}

interface RowResult {
  row: Row;
  problems: string[];
}

/** Run the mutation rows. */
export async function runRows(): Promise<RowResult[]> {
  return withHarness({}, async () => {
    const baseline = realpathSync(
      mkdtempSync(join(tmpdir(), "mx-parity-base-")),
    );
    try {
      buildBaseline(baseline);
      const out: RowResult[] = [];
      for (const row of ROWS) {
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
  });
}

// ------------------------------------------------------------- real repo

type DepMap = Map<string, string[]>;

interface Spec {
  moduleId: string;
  project: { name: string };
}

/**
 * The vitest project names of every shard, balanced by test-file count. Every
 * directory `projectDirs()` lists is placed in exactly one shard and none is
 * empty (`project: []` would mean every project). That `projectDirs()` matches
 * the projects the root config creates is pinned by the drift test in
 * `test-affected.test.ts`.
 */
export function planShards(count: number): string[][] {
  const dirs = projectDirs();
  const weight = new Map<string, number>(dirs.map((d) => [d, 0]));
  const listed = spawnSync("git", ["ls-files", "--", "*.test.*"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  }).stdout;
  for (const file of listed.split("\n")) {
    let best: string | undefined;
    for (const d of dirs) {
      if (file.startsWith(d) && (!best || d.length > best.length)) best = d;
    }
    if (best) weight.set(best, (weight.get(best) ?? 0) + 1);
  }
  const load = Array.from({ length: count }, () => 0);
  const shards: string[][] = Array.from({ length: count }, () => []);
  for (const [dir, w] of [...weight].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )) {
    const name = projectFor(dir, dirs);
    if (!name) throw new Error(`no vitest project name for ${dir}`);
    const k = load.indexOf(Math.min(...load));
    load[k] += w;
    shards[k].push(name);
  }
  const empty = shards.findIndex((p) => p.length === 0);
  if (empty >= 0) throw new Error(`shard ${empty + 1}/${count} has no project`);
  return shards;
}

/**
 * The tests a related file selects, from the cold dependency sets: every test
 * when vitest forces a full rerun for it (a force-rerun trigger such as a
 * package.json), else those that import it or are it.
 */
export function expectedSelection(
  deps: ReadonlyMap<string, readonly string[]>,
  file: string,
  forced: boolean,
  relativeName: string,
): string[] {
  if (forced) return [...deps.keys()].sort();
  return [...deps]
    .filter(
      ([test, d]) => d.includes(file) || test.endsWith(` ${relativeName}`),
    )
    .map(([test]) => test)
    .sort();
}

/** Dependency set of every test of the shard's projects. */
async function realDeps(
  store: string,
  projects: string[],
  samples?: string[],
): Promise<{
  deps: DepMap;
  line: string;
  /** per sampled file: the tests selected, and whether vitest forces a full rerun */
  sampled: Map<string, { chosen: string[]; forced: boolean }>;
}> {
  const reporter = new AffectedCacheReporter({ dir: store });
  const lines: string[] = [];
  const restore = capture(lines);
  const exitCode = process.exitCode;
  try {
    const ctx = await createVitest(
      "test",
      {
        root: repoRoot,
        watch: false,
        run: true,
        reporters: [reporter],
        project: projects,
      },
      {},
      { stdout: process.stderr },
    );
    try {
      await ctx.init();
      const missing = projects.filter(
        (p) => !ctx.projects.some((q) => q.name === p),
      );
      if (missing.length > 0) {
        throw new Error(`shard projects not found: ${missing.join(", ")}`);
      }
      // biome-ignore lint/suspicious/noExplicitAny: vitest's specification API is internal
      const internal = ctx as any;
      const specs = (await internal.globTestSpecifications()) as Spec[];
      const key = (s: Spec) =>
        `${s.project.name} ${relative(repoRoot, s.moduleId)}`;
      const deps: DepMap = new Map();
      for (const spec of specs) {
        const set = (await internal.specifications.getTestDependencies(
          spec,
        )) as Set<string>;
        deps.set(key(spec), [...set].sort());
      }
      // vitest's own matcher: a related file matching a force-rerun trigger
      // selects every test, whatever the import graph says.
      const isTrigger = createRequire(
        join(realpathSync(join(repoRoot, "node_modules", "vitest")), "/"),
      )("picomatch")(ctx.config.forceRerunTriggers) as (f: string) => boolean;
      const sampled = new Map<string, { chosen: string[]; forced: boolean }>();
      for (const f of samples ?? []) {
        ctx.config.related = [f];
        const chosen = (await internal.specifications.filterTestsBySource(
          specs,
        )) as Spec[];
        sampled.set(f, {
          chosen: chosen.map(key).sort(),
          forced: isTrigger(f),
        });
      }
      reporter.onTestRunStart();
      return { deps, line: lines.join("\n"), sampled };
    } finally {
      await ctx.close();
    }
  } finally {
    restore();
    process.exitCode = exitCode;
  }
}

/**
 * Cold-vs-warm dependency parity over one shard of this repository's tests
 * (the shards together cover every vitest project) against a store shared by
 * the shards.
 */
async function runReal(
  store: string,
  shard: [number, number],
): Promise<string[]> {
  return withHarness({ MX_TEST_LANE: "all" }, async () => {
    const problems: string[] = [];
    const projects = planShards(shard[1])[shard[0]];
    // Cold: the store is empty, so every module is transformed natively.
    const t0 = performance.now();
    const cold = await realDeps(store, projects);
    const t1 = performance.now();
    const native = /native selection \(.*\)/.exec(cold.line);
    if (native) {
      return [`cache is native here: ${native[0]}; parity cannot be proven`];
    }
    if (!/ 0 hits/.test(cold.line)) {
      problems.push(`cold run was not cold: ${cold.line}`);
    }
    const universe = new Set<string>();
    for (const d of cold.deps.values()) for (const f of d) universe.add(f);
    const all = [...universe].filter((f) => !f.includes("node_modules")).sort();
    // The root package.json is always sampled: vitest selects every test for
    // it, so the force-rerun model is exercised on every run.
    const samples = [
      join(repoRoot, "package.json"),
      ...all.filter((_, i) => i % Math.ceil(all.length / 4) === 0),
    ];
    const warm = await realDeps(store, projects, samples);
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
    for (const [f, { chosen, forced }] of warm.sampled) {
      const want = expectedSelection(
        cold.deps,
        f,
        forced,
        relative(repoRoot, f),
      );
      if (want.join("\n") !== chosen.join("\n")) {
        problems.push(
          `edit of ${relative(repoRoot, f)}: cached selects [${chosen}] but native selects [${want}]`,
        );
      }
    }
    console.log(
      `real: ${cold.deps.size} tests in ${projects.length} projects, ${all.length} files, ${samples.length} sampled edits; warm ${warm.line.split("\n").pop()}`,
    );
    return problems;
  });
}

// ------------------------------------------------- children and the hammer

const BIG_ENTRY_KEY = "ab".repeat(32);

/** Concurrent-writer probe: `write` re-puts one large entry, `read` looks for torn ones. */
async function hammer(argv: string[]): Promise<number> {
  const arg = (n: string) => argv[argv.indexOf(n) + 1];
  const store = new Store(arg("--store"), "hammer");
  const done = arg("--done");
  const deps = Array.from({ length: 20_000 }, (_, i) =>
    `/entry/${i}`.padEnd(48, "x"),
  );
  if (arg("--role") === "write") {
    for (let i = 0; i < 60; i++) {
      if (!store.put(BIG_ENTRY_KEY, { deps, dynamicDeps: [] })) {
        console.log("put failed");
        return 1;
      }
    }
    return 0;
  }
  const path = join(
    store.nsDir,
    BIG_ENTRY_KEY.slice(0, 2),
    `${BIG_ENTRY_KEY}.json`,
  );
  let reads = 0;
  let torn = 0;
  console.log("READY");
  for (;;) {
    const finished = existsSync(done);
    let text: string | undefined;
    try {
      text = readFileSync(path, "utf8");
    } catch {}
    if (text !== undefined) {
      reads++;
      try {
        JSON.parse(text);
      } catch {
        torn++;
      }
    }
    // One last pass after the writers finished, then stop.
    if (finished) break;
  }
  console.log(`RESULT ${JSON.stringify({ reads, torn })}`);
  return 0;
}

interface Spawned {
  /** resolves when the child printed `readyLine` (if one was asked for) */
  ready: Promise<void>;
  exit: Promise<{ code: number; out: string }>;
}

/** Run this script as a child with `args`. */
function spawnPart(args: string[], readyLine?: string): Spawned {
  // Node, the runtime `bunx vitest` runs under: the cache namespace includes
  // the runtime, so the one verified must be the one users get.
  const c = spawn(
    process.versions.bun ? "node" : process.execPath,
    [import.meta.filename, ...args],
    { cwd: repoRoot, env: process.env },
  );
  let out = "";
  let ready!: () => void;
  const readyP = new Promise<void>((r) => {
    ready = r;
  });
  if (!readyLine) ready();
  const onData = (d: Buffer) => {
    out += d;
    if (readyLine && out.includes(readyLine)) ready();
  };
  c.stdout.on("data", onData);
  c.stderr.on("data", onData);
  const exit = new Promise<{ code: number; out: string }>((done) => {
    // A hung child must not hang `verify` with no output.
    const timer = setTimeout(() => {
      out += `\ntimed out after ${CHILD_TIMEOUT_MS / 1000} s: ${args.join(" ")}`;
      c.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    c.on("error", (e) => {
      clearTimeout(timer);
      ready();
      done({ code: 1, out: `${out}\nspawn failed: ${e.message}` });
    });
    c.on("close", (code) => {
      clearTimeout(timer);
      ready();
      done({ code: code ?? 1, out });
    });
  });
  return { ready: readyP, exit };
}

// ------------------------------------------------------------------ main

async function part(argv: string[]): Promise<number> {
  const which = argv[argv.indexOf("--part") + 1];
  const arg = (n: string) => argv[argv.indexOf(n) + 1];
  if (process.versions.bun) {
    console.log("FAIL: a parity child ran under bun, not node");
    return 1;
  }
  if (which === "hammer") return hammer(argv);
  if (which === "select") {
    const fx = { root: arg("--root"), store: arg("--store") };
    const sel = await withHarness({}, () =>
      select(fx, { related: [arg("--related")], cached: true }),
    );
    console.log(`RESULT ${JSON.stringify(sel)}`);
    return 0;
  }
  if (which === "real") {
    const [i, n] = arg("--shard").split("/").map(Number);
    const problems = await runReal(arg("--store"), [i, n]);
    for (const p of problems) console.log(`FAIL real ${i + 1}/${n}: ${p}`);
    console.log(
      `${problems.length ? "FAIL" : "PASS"} real shard ${i + 1}/${n}`,
    );
    return problems.length ? 1 : 0;
  }
  let bad = 0;
  for (const { row, problems } of await runRows()) {
    if (problems.length === 0) console.log(`PASS row: ${row.name}`);
    else {
      bad++;
      console.log(`FAIL row: ${row.name}  [guard: ${row.guard}]`);
      for (const p of problems) console.log(`  ${p}`);
    }
  }
  return bad ? 1 : 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--part")) return part(argv);
  const started = performance.now();
  try {
    planShards(SHARDS);
  } catch (e) {
    console.log(`FAIL shards: ${(e as Error).message}`);
    return 1;
  }
  // The shards share one private store; the cold pass is the expensive one
  // (native transforms), so splitting it across processes, each initialising
  // only its own projects, keeps the verifier inside its time budget.
  const store = mkdtempSync(join(tmpdir(), "mx-parity-store-"));
  let parts: { code: number; out: string }[];
  try {
    parts = await Promise.all([
      spawnPart(["--part", "rows"]).exit,
      ...Array.from(
        { length: SHARDS },
        (_, k) =>
          spawnPart([
            "--part",
            "real",
            "--store",
            store,
            "--shard",
            `${k}/${SHARDS}`,
          ]).exit,
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
