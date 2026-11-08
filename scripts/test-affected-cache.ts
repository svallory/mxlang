/**
 * Selection cache for `bun run test:affected`.
 *
 * `vitest related` spends ~15 s serially transforming every test file and its
 * imports just to read each module's import list (`deps` + `dynamicDeps`).
 * This module caches only those two lists, on disk, for the selection phase.
 * Native `vitest related` stays the final selector (it still globs the specs,
 * walks the graph and intersects with the changed files) and execution stays
 * native: the cached lists are served through vite-node's `_transformRequest`
 * only until the run starts, then the original method is restored.
 *
 * A stale list silently drops a covering test, and a green run cannot show
 * it. So every reuse is guarded, and any doubt (a guard that cannot vouch for
 * an input, a read or parse failure, an API mismatch) is a native miss:
 *
 * - namespace  (`namespaceFor`): one key over everything that changes what a
 *   module's imports resolve to without changing the module itself: schema
 *   version, pinned vitest/vite/vite-node versions, runtime and platform,
 *   resolve conditions and per-project config, selected environment values,
 *   manifests (package.json, lockfile, tsconfig, vitest/vite configs,
 *   patches), installed package identities and symlinks, and the file
 *   inventory (an added, deleted or renamed file can change a resolution or a
 *   fallback candidate). Any difference is a different namespace, so an old
 *   entry is unreachable.
 *   The inventory is what exists on disk: tracked and untracked files minus
 *   tracked files deleted from the working tree, plus gitignored build
 *   output in each package's `dist` directory (one or two levels below
 *   `packages`). Other gitignored
 *   files (`.gen/`, deeper `dist/`, vendored sources) are not listed, so
 *   adding or removing one does not change the namespace; no test import
 *   resolves through such a path today.
 * - entry      (`entryKey`): the file's content hash, module id, transform
 *   mode and project, inside that namespace.
 * - bypass     (`bypassReason`): virtual or query ids, files that do not
 *   exist, and sources using a glob import (`import.meta.glob`,
 *   `require.context`) are never cached, because their imports depend on
 *   directory contents no content hash shows. A project whose plugins or
 *   config cannot be fingerprinted (an unknown plugin, a function or other
 *   non-canonical value) is bypassed whole.
 * - stability: the source is hashed before and after the native transform; a
 *   changing file is not stored.
 * - storage: a versioned payload with an integrity checksum, atomic
 *   content-addressed writes (temp file + rename), a size bound and GC.
 *
 * On by default for local runs; never with `CI` set or `MX_AFFECTED_NATIVE=1`
 * (and `MX_AFFECTED_CACHE=0`/`false`/`off`/`no` turns it off too). `bun run test:affected:parity`
 * (scripts/test-affected-parity.ts, a `verify` step) proves it agrees with
 * native selection.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Bump when the payload or the key model changes; old stores become unreachable. */
export const SCHEMA_VERSION = 1;

/** The private vite-node API this adapter wraps is audited for exactly these. */
export const SUPPORTED_VERSIONS: Readonly<Record<string, string>> = {
  vitest: "3.2.7",
  "vite-node": "3.2.4",
  vite: "7.3.6",
};

/**
 * The plugins vite 7.3.6 and vitest 3.2.7 register for this repo's projects
 * (printed from the real projects and pinned): their output is a function of
 * the source and the resolved config. An exact list, not a name prefix: a
 * third-party `vite:*` plugin (react, vue) carries option closures nobody
 * fingerprints.
 */
const SUPPORTED_PLUGINS: ReadonlySet<string> = new Set([
  "vite:optimized-deps",
  "vite:watch-package-data",
  "vite:pre-alias",
  "alias",
  "vitest",
  "vitest:project",
  "vitest:resolve-core",
  "vitest:ssr-replacer",
  "vitest:css-disable",
  "vitest:resolve-root",
  "vite:modulepreload-polyfill",
  "vite:resolve",
  "vite:html-inline-proxy",
  "vite:css",
  "vite:esbuild",
  "vite:json",
  "vite:wasm-helper",
  "vite:worker",
  "vite:asset",
  "vitest:coverage-transform",
  "vitest:normalize-optimizer",
  "vite:wasm-fallback",
  "vite:define",
  "vite:css-post",
  "vite:worker-import-meta-url",
  "vite:asset-import-meta-url",
  "vite:dynamic-import-vars",
  "vite:import-glob",
  "vitest:project:name",
  "vitest:project:server",
  "vitest:css-empty-post",
  "vitest:mocks",
  "vitest:automock",
  "vitest:normalize-url",
  "vite:client-inject",
  "vite:css-analysis",
  "vite:import-analysis",
]);

/** A source whose imports depend on directory contents. */
const GLOB_SOURCE =
  /import\.meta\s*\.\s*(?:glob|globEager)\b|\brequire\s*\.\s*context\b/;

/** Environment values that can change resolution or plugin behaviour. */
const ENV_RELEVANT =
  /^(?:NODE_ENV|NODE_OPTIONS|NODE_PATH|NODE_PRESERVE_SYMLINKS|NODE_CONDITIONS|BUN_.*|MODE|BABEL_.*|VITE.*|VITEST.*|MX_(?!AFFECTED_).*)$/;

const MANIFEST =
  /(?:^|\/)(?:package\.json|bun\.lockb?|tsconfig[^/]*\.json|vitest\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|\.prototools)$|^scripts\/vitest-|^patches\//;

const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_NAMESPACES = 3;

const sha = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------- switch

export type Mode = { on: true } | { on: false; reason: string };

/** Whether the cache may be read or written under this environment. */
export function cacheMode(env: NodeJS.ProcessEnv): Mode {
  if (env.CI) return { on: false, reason: "CI is set" };
  if (env.MX_AFFECTED_NATIVE === "1") {
    return { on: false, reason: "MX_AFFECTED_NATIVE=1" };
  }
  const choice = (env.MX_AFFECTED_CACHE ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(choice)) {
    return { on: false, reason: `MX_AFFECTED_CACHE=${env.MX_AFFECTED_CACHE}` };
  }
  return { on: true };
}

// ------------------------------------------------------------ canonical

class Unsupported extends Error {}

/**
 * Stable JSON for config values. RegExps are typed; a function, symbol,
 * class instance or cycle cannot be fingerprinted (its closure is invisible),
 * so it throws `Unsupported` and the caller falls back to native.
 */
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new Unsupported(`non-canonical config value (${typeof value})`);
    }
    return JSON.stringify(value);
  }
  if (value instanceof RegExp) return `re:${value}`;
  if (seen.has(value)) throw new Unsupported("cyclic config value");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => canonical(v, seen)).join(",")}]`;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Unsupported(
        `non-canonical config value (${proto?.constructor?.name})`,
      );
    }
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .filter((k) => rec[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

// --------------------------------------------------------------- inputs

export interface ProjectInput {
  name: string;
  root: string;
  plugins: string[];
  /** The resolved settings that steer resolution and transforms. */
  config: unknown;
}

export interface Inputs {
  root: string;
  versions: Record<string, string>;
  runtime: { node: string; bun: string; platform: string; arch: string };
  env: Record<string, string>;
  /** workspace-relative manifest path -> content hash */
  manifests: Record<string, string>;
  /** installed package folder names, plus top-level symlink targets */
  packages: string[];
  /** hash of the repository file list, or undefined when it cannot be read */
  inventory: string | undefined;
  projects: ProjectInput[];
}

function git(root: string, args: string[]): string | undefined {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return r.status === 0 ? r.stdout : undefined;
}

/** Read `<name>/package.json`'s version, walking up from `from` like node does. */
function installedVersion(name: string, from: string): string | undefined {
  let dir = from;
  for (;;) {
    const p = join(dir, "node_modules", name, "package.json");
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")).version;
      } catch {
        return undefined;
      }
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function symlinkTargets(nodeModules: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(nodeModules).sort();
  } catch {
    return;
  }
  for (const n of names) {
    if (n === ".bun" || n === ".cache" || n === ".vite" || n === ".bin")
      continue;
    const p = join(nodeModules, n);
    try {
      if (lstatSync(p).isSymbolicLink()) {
        out.push(`${p} -> ${readlinkSync(p)}`);
      } else if (n.startsWith("@")) {
        symlinkTargets(p, out);
      }
    } catch {
      out.push(`${p} !`);
    }
  }
}

/**
 * File list when `root` is not a git checkout (a synced copy): everything
 * outside node_modules and VCS/cache dirs, relative to `root`.
 */
function walk(root: string, rel = ""): string[] | undefined {
  const out: string[] = [];
  try {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (["node_modules", ".git", "coverage"].includes(e.name)) {
        continue;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(walk(root, r) ?? []));
      else out.push(r);
    }
  } catch {
    return undefined;
  }
  return out;
}

/** Build output of each package (one or two levels below `packages`), relative to `root`. */
function workspaceDirs(root: string): string[] {
  const dirs: string[] = [];
  const list = (rel: string): string[] => {
    try {
      return readdirSync(join(root, rel)).sort();
    } catch {
      return [];
    }
  };
  for (const a of list("packages")) {
    dirs.push(`packages/${a}`);
    for (const b of list(`packages/${a}`)) {
      if (b !== "node_modules") dirs.push(`packages/${a}/${b}`);
    }
  }
  for (const a of list("examples")) dirs.push(`examples/${a}`);
  return dirs;
}

function distFiles(root: string): string[] {
  const out: string[] = [];
  for (const d of workspaceDirs(root)) {
    if (!d.startsWith("packages/") || d.endsWith("/dist")) continue;
    if (existsSync(join(root, d, "dist"))) {
      out.push(...(walk(root, `${d}/dist`) ?? []));
    }
  }
  return out;
}

/**
 * `path -> target` for the given candidate symlinks, and whether any target
 * leaves `root`. The file list names a link once whatever it points at, but a
 * resolution follows it to the target's files, so retargeting a link must
 * change the inventory. A target outside the repository is not in the list at
 * all (a file added there would shadow a resolution unseen), so such a link
 * makes the inventory unavailable and selection native.
 */
function symlinkLines(
  root: string,
  candidates: Iterable<string>,
): { lines: string[]; escapes: boolean } {
  const lines: string[] = [];
  let escapes = false;
  for (const f of candidates) {
    try {
      const p = resolve(root, f);
      if (!lstatSync(p).isSymbolicLink()) continue;
      const target = readlinkSync(p);
      lines.push(`${f} -> ${target}`);
      const rel = relative(resolve(root), resolve(dirname(p), target));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        escapes = true;
      }
    } catch {}
  }
  return { lines: lines.sort(), escapes };
}

/** Gather every namespace input for `root` from disk and the environment. */
export function collectInputs(
  root: string,
  projects: ProjectInput[],
  env: NodeJS.ProcessEnv,
  vitestDir: string,
): Inputs {
  const versions: Record<string, string> = {};
  for (const name of Object.keys(SUPPORTED_VERSIONS)) {
    versions[name] = installedVersion(name, vitestDir) ?? "missing";
  }
  // One git call: `-t` tags each entry, and a tracked file deleted from the
  // working tree is listed (as `H`) and again as `R`, so `R` paths are
  // subtracted.
  const listing = git(root, [
    "ls-files",
    "-z",
    "-t",
    "-c",
    "-d",
    "-o",
    "--exclude-standard",
  ]);
  let files: string[] | undefined;
  // Candidate symlinks: tracked ones come from the index (mode 120000), so
  // only untracked files need an lstat; outside a git checkout every file does.
  let linkCandidates: Iterable<string> = [];
  if (listing === undefined) {
    files = walk(root);
    linkCandidates = files ?? [];
  } else {
    const gone = new Set<string>();
    const present: string[] = [];
    const untracked: string[] = [];
    for (const entry of listing.split("\0")) {
      if (!entry) continue;
      const path = entry.slice(2);
      if (entry.startsWith("R ")) gone.add(path);
      else {
        present.push(path);
        if (entry.startsWith("? ")) untracked.push(path);
      }
    }
    const tracked: string[] = [];
    for (const e of (git(root, ["ls-files", "-s", "-z"]) ?? "").split("\0")) {
      const tab = e.indexOf("\t");
      if (tab > 0 && e.startsWith("120000 ")) tracked.push(e.slice(tab + 1));
    }
    linkCandidates = [...tracked.filter((f) => !gone.has(f)), ...untracked];
    // Build output resolved through workspace links is gitignored but followed.
    files = [
      ...new Set([...present.filter((f) => !gone.has(f)), ...distFiles(root)]),
    ];
  }
  let links: string | undefined;
  if (files !== undefined) {
    const sym = symlinkLines(root, linkCandidates);
    if (!sym.escapes) links = [...files].sort().concat(sym.lines).join("\n");
  }
  const manifests: Record<string, string> = {};
  for (const f of files ?? []) {
    if (!MANIFEST.test(f)) continue;
    try {
      manifests[f] = sha(readFileSync(resolve(root, f)));
    } catch {
      manifests[f] = "unreadable";
    }
  }
  const packages: string[] = [];
  try {
    packages.push(...readdirSync(join(root, "node_modules", ".bun")).sort());
  } catch {}
  // Every workspace package, not only the vitest projects: a package the
  // tests reach through a link (for example a host's dist) can be re-linked.
  for (const dir of new Set([
    root,
    ...projects.map((p) => p.root),
    ...workspaceDirs(root).map((d) => join(root, d)),
  ])) {
    symlinkTargets(join(dir, "node_modules"), packages);
  }
  packages.sort();
  const envOut: Record<string, string> = {};
  for (const k of Object.keys(env).sort()) {
    if (ENV_RELEVANT.test(k) && env[k] !== undefined)
      envOut[k] = env[k] as string;
  }
  return {
    root,
    versions,
    runtime: {
      node: process.version,
      bun: process.versions.bun ?? "",
      platform: process.platform,
      arch: process.arch,
    },
    env: envOut,
    manifests,
    packages,
    inventory: links === undefined ? undefined : sha(links),
    projects,
  };
}

// ------------------------------------------------------------- namespace

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A project's namespace component, or why that project must stay native. */
export function projectKey(p: ProjectInput): Verdict<string> {
  const unknown = p.plugins.find((n) => !SUPPORTED_PLUGINS.has(n));
  if (unknown !== undefined) {
    return { ok: false, reason: `unsupported plugin ${unknown} in ${p.name}` };
  }
  try {
    return {
      ok: true,
      value: sha(
        canonical({
          name: p.name,
          root: p.root,
          plugins: p.plugins,
          config: p.config,
        }),
      ),
    };
  } catch (e) {
    return { ok: false, reason: `${p.name}: ${(e as Error).message}` };
  }
}

/**
 * The namespace key for a whole run, or the reason nothing may be served. A
 * project-level problem does not fail the namespace: that project is bypassed
 * (see `projectKeys`).
 */
export function namespaceFor(i: Inputs): Verdict<string> {
  for (const [name, want] of Object.entries(SUPPORTED_VERSIONS)) {
    if (i.versions[name] !== want) {
      return {
        ok: false,
        reason: `${name} ${i.versions[name] ?? "missing"} is not the audited ${want}`,
      };
    }
  }
  if (i.inventory === undefined) {
    return {
      ok: false,
      reason: "file inventory unavailable (or a symlink leaves the repository)",
    };
  }
  return {
    ok: true,
    value: sha(
      canonical({
        schema: SCHEMA_VERSION,
        root: i.root,
        versions: i.versions,
        runtime: i.runtime,
        env: i.env,
        manifests: i.manifests,
        packages: i.packages,
        inventory: i.inventory,
      }),
    ),
  };
}

// ---------------------------------------------------------------- entries

export interface Deps {
  deps: string[];
  dynamicDeps: string[];
}

export interface EntryRequest {
  project: string;
  projectKey: string;
  id: string;
  filepath: string;
  mode: string;
}

/** Why a request must not touch the cache (undefined: it may). */
export function bypassReason(
  req: Pick<EntryRequest, "id" | "filepath">,
  source: Uint8Array | undefined,
): string | undefined {
  if (!req.filepath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(req.filepath)) {
    return "virtual id";
  }
  if (req.id.includes("?") || req.id.includes("\0"))
    return "query or virtual id";
  if (source === undefined) return "source unreadable";
  if (GLOB_SOURCE.test(Buffer.from(source).toString("utf8"))) {
    return "glob import (imports depend on directory contents)";
  }
  return undefined;
}

export function entryKey(
  ns: string,
  req: EntryRequest,
  contentHash: string,
): string {
  return sha(
    JSON.stringify([
      ns,
      req.project,
      req.projectKey,
      req.id,
      req.filepath,
      req.mode,
      contentHash,
    ]),
  );
}

// ------------------------------------------------------------------ store

interface Payload {
  schema: number;
  key: string;
  deps: string[];
  dynamicDeps: string[];
  sum: string;
}

const sumOf = (key: string, d: Deps): string =>
  sha(JSON.stringify([key, d.deps, d.dynamicDeps]));

/** Content-addressed, namespaced, atomic store. Every failure is a miss. */
export class Store {
  readonly nsDir: string;
  constructor(
    readonly dir: string,
    readonly ns: string,
  ) {
    this.nsDir = join(dir, `v${SCHEMA_VERSION}`, ns);
  }

  private path(key: string): string {
    return join(this.nsDir, key.slice(0, 2), `${key}.json`);
  }

  get(key: string): Deps | undefined {
    try {
      const p = JSON.parse(readFileSync(this.path(key), "utf8")) as Payload;
      if (p.schema !== SCHEMA_VERSION || p.key !== key) return undefined;
      if (!Array.isArray(p.deps) || !Array.isArray(p.dynamicDeps))
        return undefined;
      if (![...p.deps, ...p.dynamicDeps].every((d) => typeof d === "string")) {
        return undefined;
      }
      const deps = { deps: p.deps, dynamicDeps: p.dynamicDeps };
      return p.sum === sumOf(key, deps) ? deps : undefined;
    } catch {
      return undefined;
    }
  }

  /** Atomic publish; a failed write is harmless. */
  put(key: string, d: Deps): boolean {
    try {
      const path = this.path(key);
      mkdirSync(dirname(path), { recursive: true });
      const payload: Payload = {
        schema: SCHEMA_VERSION,
        key,
        deps: d.deps,
        dynamicDeps: d.dynamicDeps,
        sum: sumOf(key, d),
      };
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, path);
      return true;
    } catch {
      return false;
    }
  }

  /** Mark this namespace as used now (GC orders namespaces by it). */
  touch(): void {
    try {
      mkdirSync(this.nsDir, { recursive: true });
      const marker = join(this.nsDir, ".used");
      writeFileSync(marker, "");
      const now = new Date();
      utimesSync(marker, now, now);
    } catch {}
  }

  /**
   * Keep the newest `maxNamespaces` namespaces (this one always), drop
   * leftover temp files, then evict oldest entries until under `maxBytes`.
   */
  gc(
    maxBytes = MAX_STORE_BYTES,
    maxNamespaces = MAX_NAMESPACES,
    now = Date.now(),
  ): void {
    try {
      const versionDir = join(this.dir, `v${SCHEMA_VERSION}`);
      for (const v of readdirSync(this.dir)) {
        if (/^v\d+$/.test(v) && v !== `v${SCHEMA_VERSION}`)
          rmSync(join(this.dir, v), { recursive: true, force: true });
      }
      const spaces = readdirSync(versionDir)
        .map((n) => ({ n, t: mtime(join(versionDir, n, ".used")) }))
        .sort((a, b) => b.t - a.t || a.n.localeCompare(b.n));
      for (const s of spaces
        .filter((s) => s.n !== this.ns)
        .slice(Math.max(0, maxNamespaces - 1))) {
        rmSync(join(versionDir, s.n), { recursive: true, force: true });
      }
      const files: { p: string; size: number; t: number }[] = [];
      let total = 0;
      for (const s of readdirSync(versionDir)) {
        for (const shard of readdirSync(join(versionDir, s))) {
          if (shard === ".used") continue;
          for (const f of readdirSync(join(versionDir, s, shard))) {
            const p = join(versionDir, s, shard, f);
            const st = statSync(p);
            if (f.endsWith(".tmp") && now - st.mtimeMs > 60_000) {
              rmSync(p, { force: true });
              continue;
            }
            files.push({ p, size: st.size, t: st.mtimeMs });
            total += st.size;
          }
        }
      }
      files.sort((a, b) => a.t - b.t);
      for (const f of files) {
        if (total <= maxBytes) break;
        rmSync(f.p, { force: true });
        total -= f.size;
      }
    } catch {}
  }
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ hook

export interface Stats {
  hits: number;
  misses: number;
  bypassed: number;
  unstable: number;
  reasons: Map<string, number>;
}

export interface Installed {
  stats: Stats;
  /** Restore native transforms and run GC; idempotent. */
  finish(): void;
}

interface ViteNodeLike {
  _transformRequest?: (
    id: string,
    filepath: string,
    mode: string,
  ) => Promise<unknown>;
  transformPromiseMap?: Record<string, Map<string, unknown>>;
}

export interface ProjectLike {
  name: string;
  vitenode: ViteNodeLike;
  /** the project's input record, as built for `collectInputs` */
  input: ProjectInput;
}

/**
 * Serve cached import lists through each project's vite-node until `finish`.
 * Returns undefined (native) when the namespace cannot be vouched for.
 */
export function install(
  projects: ProjectLike[],
  inputs: Inputs,
  storeDir: string,
  note: (msg: string) => void = () => {},
): Installed | undefined {
  const ns = namespaceFor(inputs);
  if (!ns.ok) {
    note(`native selection: ${ns.reason}`);
    return undefined;
  }
  const store = new Store(storeDir, ns.value);
  store.touch();
  const stats: Stats = {
    hits: 0,
    misses: 0,
    bypassed: 0,
    unstable: 0,
    reasons: new Map(),
  };
  const bypass = (why: string) => {
    stats.bypassed++;
    stats.reasons.set(why, (stats.reasons.get(why) ?? 0) + 1);
  };
  const restores: (() => void)[] = [];
  const sourceFacts = new Map<
    string,
    { why: string | undefined; hash: string }
  >();

  for (const project of projects) {
    const node = project.vitenode;
    const original = node._transformRequest;
    const pk = projectKey(project.input);
    if (typeof original !== "function") {
      note(`${project.name}: vite-node _transformRequest missing, native`);
      continue;
    }
    if (!pk.ok) {
      note(`${pk.reason}, native`);
      continue;
    }
    node._transformRequest = async function (
      this: unknown,
      id,
      filepath,
      mode,
    ) {
      const native = () => original.call(this, id, filepath, mode);
      // The same file is requested once per project: read and hash it once.
      const seen = `${filepath}\0${id}`;
      let facts = sourceFacts.get(seen);
      if (!facts) {
        let source: Buffer | undefined;
        try {
          source = readFileSync(filepath);
        } catch {}
        const why = bypassReason({ id, filepath }, source);
        facts = {
          why: why ?? (source === undefined ? "source unreadable" : undefined),
          hash: source === undefined ? "" : sha(source),
        };
        sourceFacts.set(seen, facts);
      }
      if (facts.why !== undefined) {
        bypass(facts.why);
        return native();
      }
      const before = facts.hash;
      const key = entryKey(
        ns.value,
        { project: project.name, projectKey: pk.value, id, filepath, mode },
        before,
      );
      const hit = store.get(key);
      if (hit) {
        stats.hits++;
        // Selection only reads the two lists; no code is served.
        return { ...hit } as unknown;
      }
      stats.misses++;
      const result = (await native()) as Partial<Deps> | null;
      if (!result) return result;
      let after: string | undefined;
      try {
        after = sha(readFileSync(filepath));
      } catch {}
      if (after !== before) {
        stats.unstable++;
        return result;
      }
      store.put(key, {
        deps: [...(result.deps ?? [])],
        dynamicDeps: [...(result.dynamicDeps ?? [])],
      });
      return result;
    };
    restores.push(() => {
      node._transformRequest = original;
      // Stubs live in the selection-phase promise maps only; drop them anyway.
      for (const m of Object.values(node.transformPromiseMap ?? {})) m.clear();
    });
  }
  if (restores.length === 0) return undefined;
  let done = false;
  return {
    stats,
    finish() {
      if (done) return;
      done = true;
      for (const r of restores) r();
      store.gc();
    },
  };
}
