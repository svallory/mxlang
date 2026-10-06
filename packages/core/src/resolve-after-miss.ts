/**
 * Resolution of a target specifier that this process's resolver has already
 * reported missing.
 *
 * Both runtimes keep resolution state for the life of a process: Bun keeps a
 * miss once the project has a `node_modules`, and Node keeps a missing
 * `package.json`, so after an install Node resolves the package's `index.js`
 * and ignores its `main`. Neither can be asked to forget. So once a specifier
 * has missed here, it is resolved by the same runtime in a fresh child
 * process (`process.execPath`, `createRequire(fromDir/package.json).resolve`),
 * whose cache is empty: the answer is the runtime's own, whatever this
 * process saw before.
 *
 * The gate: a child runs at most once per specifier per change on disk. Each
 * answer is kept with a stamp of the paths an install or upgrade touches
 * (inode, mtime and size of, for each directory from `fromDir` up:
 * `node_modules`, the scope directory, the package directory and its
 * `package.json`, the directory's own `package.json`, `tsconfig.json`,
 * `jsconfig.json` and `.pnp.cjs`; for a relative or absolute specifier, the
 * target path and its two parent directories). While the stamp is unchanged
 * the kept answer is reused, a failure included. Each package's `package.json`
 * also names its entry paths (`main`, every `exports` target for the
 * subpath), and each one and its parent directory are stamped too, so a build
 * that writes `dist/index.js` into an existing `dist/` is a change. The stamp
 * costs about eight `statSync` calls per directory from `fromDir` up (some
 * 80 to 100 per lookup at a typical depth), plus one `package.json` read per
 * package whose stat changed, on every lookup of a specifier that has missed.
 *
 * A kept answer that is not "found" is also re-asked on a backoff while the
 * stamp stays unchanged, for what the stamp cannot see (an entry under a
 * deeper directory, a Bun tsconfig `paths` target): first 5 seconds after
 * the answer, then doubling to at most 60 seconds; any stamp change resets
 * it. A package that only appears through `NODE_PATH` or a global folder is
 * not stamped: it is found by that backoff.
 *
 * `node:child_process` is loaded on this path only, never when core loads, so
 * an environment without it still imports core: a miss then stays a miss,
 * with a message that says why.
 */

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** @internal */
export type MissResolution =
  /** The runtime resolves the specifier to this file. */
  | { kind: "found"; path: string }
  /** The runtime's resolver rejects it, with its own error code and message. */
  | { kind: "error"; code: string; message: string }
  /** The child process gave no answer; `reason` says why. */
  | { kind: "failed"; reason: string };

type SpawnSync = typeof import("node:child_process").spawnSync;

const loadSpawnSync = (): SpawnSync =>
  createRequire(import.meta.url)("node:child_process").spawnSync;

let spawnSyncLoader: () => SpawnSync = loadSpawnSync;

/**
 * Replaces how `node:child_process`'s `spawnSync` is obtained; `undefined`
 * restores it, and clears every kept answer. For tests.
 *
 * @internal
 */
export function setSpawnSyncLoaderForTesting(
  loader: (() => SpawnSync) | undefined,
): void {
  spawnSyncLoader = loader ?? loadSpawnSync;
  answers.clear();
  missed.clear();
}

/** How long a child may take, in milliseconds. */
const TIMEOUT_MS = 15_000;

/** Prefixes the child's answer, so stray output cannot be mistaken for it. */
const MARK = "@@mx-resolve@@";

const CHILD_SCRIPT = `
const r = require("module").createRequire(process.env.MX_RESOLVE_FROM);
let answer;
try {
  answer = { path: r.resolve(process.env.MX_RESOLVE_SPEC) };
} catch (e) {
  answer = {
    code: String((e && e.code) || ""),
    message: String((e && e.message) || e).split("\\n")[0],
  };
}
process.stdout.write("\\n${MARK}" + JSON.stringify(answer) + "\\n");
`;

/** Runtime flags that change how a specifier resolves; the child gets them. */
const RESOLUTION_FLAG =
  /^(?:--conditions|-C|--preserve-symlinks|--preserve-symlinks-main|--no-addons|--experimental-require-module|--no-experimental-require-module)(=|$)/;

function resolutionFlags(): string[] {
  const flags: string[] = [];
  const args = process.execArgv;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const match = RESOLUTION_FLAG.exec(arg);
    if (!match) continue;
    flags.push(arg);
    const takesValue = arg === "--conditions" || arg === "-C";
    if (takesValue && i + 1 < args.length) flags.push(args[++i] as string);
  }
  return flags;
}

const key = (spec: string, fromDir: string) => `${fromDir}\0${spec}`;

/** Specifiers this process's resolver has reported missing. */
const missed = new Set<string>();

interface Kept {
  stamp: string;
  answer: MissResolution;
  /** The backoff, in milliseconds, before a non-found answer is re-asked. */
  backoff: number;
  /** When it may next be re-asked (`Date.now()` milliseconds). */
  retryAt: number;
}

const answers = new Map<string, Kept>();

/** The first re-ask of a non-found answer, and the most the backoff grows to. */
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

/** Whether `spec` has missed from `fromDir` in this process. @internal */
export function hasMissed(spec: string, fromDir: string): boolean {
  return missed.has(key(spec, fromDir));
}

/** The paths whose change can turn a miss into a hit. */
function stampedPaths(spec: string, fromDir: string): string[] {
  if (spec.startsWith(".") || isAbsolute(spec) || /^[a-z]:/i.test(spec)) {
    const target = resolve(fromDir, spec);
    return [target, dirname(target), dirname(dirname(target))];
  }
  const parts = spec.split("/");
  const scoped = spec.startsWith("@");
  const name = parts.slice(0, scoped ? 2 : 1);
  const paths: string[] = [];
  let dir = fromDir;
  for (;;) {
    const nodeModules = join(dir, "node_modules");
    paths.push(nodeModules);
    if (scoped) paths.push(join(nodeModules, name[0] as string));
    const pkg = join(nodeModules, ...name);
    paths.push(
      pkg,
      join(pkg, "package.json"),
      ...entryPaths(pkg, parts.slice(name.length).join("/")),
      join(dir, "package.json"),
      join(dir, "tsconfig.json"),
      join(dir, "jsconfig.json"),
      join(dir, ".pnp.cjs"),
    );
    const parent = dirname(dir);
    if (parent === dir) return paths;
    dir = parent;
  }
}

/** Parsed manifests, by path and the stat they were read at. */
const manifests = new Map<string, { stat: string; value: unknown }>();

function readManifest(path: string): unknown {
  let stat: string;
  try {
    const s = statSync(path);
    stat = `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    manifests.delete(path);
    return undefined;
  }
  const kept = manifests.get(path);
  if (kept?.stat === stat) return kept.value;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    value = undefined;
  }
  manifests.set(path, { stat, value });
  return value;
}

/** Every string a value of `exports` holds (targets, at any depth). */
function targetStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) targetStrings(entry, out);
  }
  return out;
}

/**
 * The entry files `pkg`'s manifest names for `subpath` (`""` for the
 * package itself), with their parent directories: the files a build writes
 * last. Not a resolution: every candidate a manifest names is stamped, valid
 * or not, so the stamp only grows.
 */
function entryPaths(pkg: string, subpath: string): string[] {
  const manifest = readManifest(join(pkg, "package.json"));
  const relative: string[] = [];
  if (subpath !== "") relative.push(subpath);
  if (manifest !== null && typeof manifest === "object") {
    const { main, exports } = manifest as { main?: unknown; exports?: unknown };
    if (typeof main === "string") relative.push(main);
    const key = subpath === "" ? "." : `./${subpath}`;
    const scoped =
      exports !== null &&
      typeof exports === "object" &&
      !Array.isArray(exports) &&
      Object.keys(exports).some((k) => k.startsWith("."))
        ? (exports as Record<string, unknown>)[key]
        : key === "."
          ? exports
          : undefined;
    targetStrings(scoped, relative);
  }
  const paths: string[] = [];
  for (const entry of relative) {
    if (entry.includes("*")) continue;
    const file = resolve(pkg, entry);
    paths.push(file, dirname(file));
  }
  return paths;
}

function stampOf(spec: string, fromDir: string): string {
  return stampedPaths(spec, fromDir)
    .map((path) => {
      try {
        const s = statSync(path);
        return `${s.ino}:${s.mtimeMs}:${s.size}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

function spawnResolve(spec: string, fromDir: string): MissResolution {
  let spawnSync: SpawnSync;
  try {
    spawnSync = spawnSyncLoader();
  } catch (cause) {
    return {
      kind: "failed",
      reason: `node:child_process is unavailable (${firstLine(cause)}), so a target installed since the miss needs a restart`,
    };
  }
  const out = spawnSync(
    process.execPath,
    [...resolutionFlags(), "-e", CHILD_SCRIPT],
    {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // An Electron host (VS Code's tsserver) runs its binary as Node.
        ELECTRON_RUN_AS_NODE: "1",
        MX_RESOLVE_FROM: join(fromDir, "package.json"),
        MX_RESOLVE_SPEC: spec,
      },
    },
  );
  const runtime = `${process.execPath}`;
  if (out.error) {
    const timedOut = (out.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      kind: "failed",
      reason: timedOut
        ? `resolving it in a child process (${runtime}) timed out after ${TIMEOUT_MS} ms`
        : `resolving it in a child process (${runtime}) failed: ${firstLine(out.error)}`,
    };
  }
  const line = String(out.stdout ?? "")
    .split("\n")
    .find((text) => text.startsWith(MARK));
  let answer: unknown;
  try {
    answer =
      line === undefined ? undefined : JSON.parse(line.slice(MARK.length));
  } catch {
    answer = undefined;
  }
  if (isAnswer(answer)) {
    if (!("path" in answer)) {
      return { kind: "error", code: answer.code, message: answer.message };
    }
    if (isAbsolute(answer.path) && isFile(answer.path)) {
      return { kind: "found", path: answer.path };
    }
    return {
      kind: "failed",
      reason: `resolving it in a child process (${runtime}) printed a path that is not an existing absolute file: ${JSON.stringify(answer.path)}`,
    };
  }
  const detail =
    out.status !== 0
      ? `exited with ${out.signal ?? `status ${out.status}`}: ${firstLine(String(out.stderr ?? "")) || "no output"}`
      : `printed no answer: ${firstLine(String(out.stdout ?? "")) || "no output"}`;
  return {
    kind: "failed",
    reason: `resolving it in a child process (${runtime}) ${detail}`,
  };
}

function isAnswer(
  value: unknown,
): value is { path: string } | { code: string; message: string } {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (typeof v.path === "string" && v.path !== "") ||
    (typeof v.code === "string" && typeof v.message === "string")
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function firstLine(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return (text.split("\n", 1)[0] as string).trim();
}

/**
 * The runtime's answer for a specifier that has missed in this process, from
 * a fresh child process of the same runtime: once per change on disk, and
 * for a non-found answer also on the backoff (5 s, doubling to 60 s).
 * Marks the specifier missed, so later calls come here too: a hit in this
 * process may be stale (Node's kept `package.json` miss) once it has missed.
 *
 * @internal
 */
export function resolveAfterMiss(
  spec: string,
  fromDir: string,
): MissResolution {
  const k = key(spec, fromDir);
  missed.add(k);
  const stamp = stampOf(spec, fromDir);
  const now = Date.now();
  const kept = answers.get(k);
  let backoff = FIRST_RETRY_MS;
  if (kept && kept.stamp === stamp) {
    if (kept.answer.kind === "found" || now < kept.retryAt) return kept.answer;
    backoff = Math.min(kept.backoff * 2, MAX_RETRY_MS);
  }
  const answer = spawnResolve(spec, fromDir);
  answers.set(k, { stamp, answer, backoff, retryAt: now + backoff });
  return answer;
}
