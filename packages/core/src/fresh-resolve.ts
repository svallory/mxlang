/**
 * A filesystem-only resolution of a bare specifier for a CommonJS `require`,
 * modelled on the running runtime's own resolver (Bun or Node). Every rule
 * below was measured on Bun 1.3.14 and Node 26.7; `fresh-resolve.test.ts`
 * holds the measurements as a differential test against the runtime itself.
 *
 * `loadTargetDescriptor` uses it **before** `require.resolve`, not only after a
 * miss, because both runtimes keep resolution state for the life of the
 * process: Bun keeps a miss once the project has a `node_modules`, and Node
 * keeps a missing `package.json`, so after an install Node resolves the
 * package's `index.js` and ignores its `main`. Reading the disk on every call
 * is what makes the outcome independent of whether a miss came first.
 *
 * What it models, in the runtime's order:
 * - self-reference: the package scope enclosing `fromDir`, when its `name`
 *   matches and it has `exports`;
 * - each `node_modules` from `fromDir` up (a directory named `node_modules`
 *   adds none of its own), with no realpath of `fromDir`, as both runtimes do:
 *   - `exports`, when the package has it: exact subpath keys and `*` patterns,
 *     the runtime's conditions in the package's key order, targets validated
 *     like Node's PACKAGE_TARGET_RESOLVE (`./` prefix; no empty, `.`, `..` or
 *     `node_modules` segment) and statted verbatim. The answer is final;
 *   - otherwise the legacy lookup: the path as a file, then with each
 *     extension, then as a directory (`main`, else `index`), with each
 *     runtime's own extension lists. `main` is not validated: both runtimes
 *     follow a `main` out of the package.
 * - nothing found in any `node_modules`: `absent`, and the caller asks the
 *   runtime (`NODE_PATH`, global folders, Yarn PnP, a built-in module).
 *
 * Divergences between the runtimes, all followed per runtime: a manifest that
 * is not a JSON object is an invalid package config on Node and ignored by
 * Bun; Node ignores an `exports` that is not a string or an object, Bun
 * exports nothing for it; a `main` that resolves to nothing ends the lookup on
 * Node and moves on to the next `node_modules` on Bun.
 *
 * Not followed: Bun on Linux normalizes a specifier's `..` segments
 * (`pkg/../other`) before resolving it, and Bun on macOS does not; a `*`
 * pattern match containing one is an invalid target here, as on Node.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const BUN = "bun" in process.versions;

/** The runtime's command-line options, including `NODE_OPTIONS`. */
function runtimeOptions(): string[] {
  return [
    ...process.execArgv,
    ...(process.env.NODE_OPTIONS?.split(/\s+/).filter(Boolean) ?? []),
  ];
}

/** `--conditions=x`, `--conditions x`, `-C x` and `-C=x`. */
function userConditions(options: readonly string[]): string[] {
  const conditions: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const match = /^(?:--conditions|-C)(?:=(.*))?$/.exec(options[i] as string);
    if (!match) continue;
    const value = match[1] ?? options[++i];
    if (value) conditions.push(value);
  }
  return conditions;
}

const OPTIONS = runtimeOptions();

/** The conditions a `require` matches in this runtime. */
const CONDITIONS: ReadonlySet<string> = new Set([
  ...(BUN ? ["bun"] : []),
  "node",
  "require",
  "default",
  ...(OPTIONS.includes("--no-addons") ? [] : ["node-addons"]),
  ...userConditions(OPTIONS),
]);

/** Extensions tried after a path that is not a file, and for `index`. */
const MODULE_EXTENSIONS = BUN
  ? [
      ".jsx",
      ".cjs",
      ".js",
      ".mjs",
      ".mts",
      ".tsx",
      ".ts",
      ".cts",
      ".json",
      ".node",
    ]
  : [".js", ".json", ".node"];

/** Extensions tried for a `main` field and for `main`'s directory `index`. */
const MAIN_EXTENSIONS = BUN
  ? [".js", ".cjs", ".cts", ".tsx", ".ts", ".jsx", ".json"]
  : MODULE_EXTENSIONS;

/** Node keeps a symlinked path under `--preserve-symlinks`. */
const PRESERVE_SYMLINKS =
  !BUN &&
  (OPTIONS.includes("--preserve-symlinks") ||
    process.env.NODE_PRESERVE_SYMLINKS === "1");

/** @internal */
export type FreshResolution =
  /** The file the runtime would load. */
  | { kind: "file"; path: string }
  /** The package is there and resolves nothing; `reason` says why. */
  | { kind: "missing"; reason: string }
  /** The package is there and unusable (Node's invalid package config/target). */
  | { kind: "invalid"; manifest: string; reason: string }
  /** Not a bare specifier, or no `node_modules` holds it: ask the runtime. */
  | { kind: "absent" };

/** A manifest problem, raised inside the `exports` walk. */
class InvalidPackage extends Error {}

/** Node's `invalidSegmentRegEx`, without the percent-encoded spellings. */
const INVALID_SEGMENT = /^(|\.|\.\.|node_modules)$/i;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The first of `stem` + each extension that is a file. */
function withExtension(
  stem: string,
  extensions: readonly string[],
): string | undefined {
  for (const extension of extensions) {
    if (isFile(stem + extension)) return stem + extension;
  }
  return undefined;
}

type Manifest =
  | { kind: "none" }
  | { kind: "object"; value: Record<string, unknown> }
  | { kind: "unusable"; reason: string };

function readManifest(path: string): Manifest {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: "none" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { kind: "unusable", reason: message.split("\n", 1)[0] as string };
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { kind: "object", value: value as Record<string, unknown> }
    : { kind: "unusable", reason: "not a JSON object" };
}

/**
 * Resolves an `exports` value for a `require`, as Node's
 * PACKAGE_TARGET_RESOLVE does: a string must start with `./` and have no
 * empty, `.`, `..` or `node_modules` segment once `*` is replaced; an array
 * takes the first entry that resolves (an invalid one is remembered and thrown
 * if none does); a condition object takes the first key, in the package's own
 * order, that this runtime matches. `null` is an explicit "not exported".
 */
function exportsTarget(
  target: unknown,
  match: string | undefined,
): string | null | undefined {
  if (typeof target === "string") {
    const replaced =
      match === undefined ? target : target.replaceAll("*", match);
    if (
      !target.startsWith("./") ||
      replaced
        .slice(2)
        .split(/[\\/]/)
        .some((segment) => INVALID_SEGMENT.test(segment))
    ) {
      throw new InvalidPackage(`invalid package target "${replaced}"`);
    }
    return replaced;
  }
  if (target === null || target === undefined) return target;
  if (Array.isArray(target)) {
    let invalid: InvalidPackage | undefined;
    for (const entry of target) {
      try {
        const found = exportsTarget(entry, match);
        if (found === undefined) continue;
        if (found === null) {
          invalid = undefined;
          continue;
        }
        return found;
      } catch (cause) {
        if (!(cause instanceof InvalidPackage)) throw cause;
        invalid = cause;
      }
    }
    if (invalid) throw invalid;
    return undefined;
  }
  if (typeof target === "object") {
    for (const [condition, value] of Object.entries(target)) {
      if (!CONDITIONS.has(condition)) continue;
      const found = exportsTarget(value, match);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  throw new InvalidPackage(`invalid package target ${JSON.stringify(target)}`);
}

/**
 * The target `exports` gives `subpath`, and the text a `*` pattern matched.
 * A subpath map's keys all start with `.`; a condition map's none do; a mix
 * is an invalid config. A string or array is the main entry's sugar. Pattern
 * keys are ordered as Node's PATTERN_KEY_COMPARE orders them (longest prefix
 * before the `*`, then the longest key).
 */
function exportsEntry(
  exp: unknown,
  subpath: string,
): { target: unknown; match?: string } {
  if (typeof exp === "object" && exp !== null && !Array.isArray(exp)) {
    const keys = Object.keys(exp);
    const subpaths = keys.filter((key) => key.startsWith("."));
    if (subpaths.length > 0 && subpaths.length < keys.length) {
      throw new InvalidPackage(
        'invalid package config: "exports" mixes subpath keys with condition keys',
      );
    }
    if (subpaths.length > 0) {
      const map = exp as Record<string, unknown>;
      if (Object.hasOwn(map, subpath) && !subpath.includes("*")) {
        return { target: map[subpath] };
      }
      let best: string | undefined;
      for (const key of subpaths) {
        const star = key.indexOf("*");
        if (star === -1 || star !== key.lastIndexOf("*")) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (
          subpath.length >= key.length &&
          subpath.startsWith(prefix) &&
          subpath.endsWith(suffix) &&
          (best === undefined || comparePatternKeys(key, best) < 0)
        ) {
          best = key;
        }
      }
      if (best === undefined) return { target: undefined };
      const star = best.indexOf("*");
      return {
        target: map[best],
        match: subpath.slice(star, subpath.length - (best.length - star - 1)),
      };
    }
  }
  return { target: subpath === "." ? exp : undefined };
}

/** Node's PATTERN_KEY_COMPARE: negative when `a` is the better match. */
function comparePatternKeys(a: string, b: string): number {
  const aStar = a.indexOf("*");
  const bStar = b.indexOf("*");
  if (aStar !== bStar) return bStar - aStar;
  return b.length - a.length;
}

/** Whether this runtime treats `exp` as an `exports` field at all. */
function hasExports(exp: unknown): boolean {
  if (exp === undefined || exp === null) return false;
  // Node ignores a `false` or a number; Bun exports nothing for one.
  return BUN || typeof exp === "string" || typeof exp === "object";
}

/** `exports` of the package at `pkgDir`, for `subpath`. Always final. */
function resolveExports(
  pkgDir: string,
  manifestPath: string,
  exp: unknown,
  subpath: string,
): FreshResolution {
  let target: string | null | undefined;
  try {
    const entry = exportsEntry(exp, subpath);
    target = exportsTarget(entry.target, entry.match);
  } catch (cause) {
    if (!(cause instanceof InvalidPackage)) throw cause;
    return { kind: "invalid", manifest: manifestPath, reason: cause.message };
  }
  if (typeof target !== "string") {
    return {
      kind: "missing",
      reason: `${manifestPath} does not export "${subpath}" for require`,
    };
  }
  const file = resolve(pkgDir, target);
  return isFile(file)
    ? { kind: "file", path: file }
    : { kind: "missing", reason: `its exported entry ${file} does not exist` };
}

type DirectoryResult =
  | FreshResolution
  /** Nothing here; the walk continues. */
  | undefined;

/**
 * A directory as a module: its `main` (with `MAIN_EXTENSIONS`, then
 * `main/index`), then its `index` (with `MODULE_EXTENSIONS`). A `main` that
 * resolves to nothing, with no `index` either, ends the lookup on Node.
 */
function resolveDirectory(dir: string, manifest: Manifest): DirectoryResult {
  const manifestPath = join(dir, "package.json");
  if (manifest.kind === "unusable" && !BUN) {
    return {
      kind: "invalid",
      manifest: manifestPath,
      reason: `invalid package config (${manifest.reason})`,
    };
  }
  const main =
    manifest.kind === "object" ? manifest.value.main : (undefined as unknown);
  const index = withExtension(join(dir, "index"), MODULE_EXTENSIONS);
  if (typeof main !== "string" || main === "") {
    return index === undefined ? undefined : { kind: "file", path: index };
  }
  const target = resolve(dir, main);
  const found =
    (isFile(target) ? target : undefined) ??
    withExtension(target, MAIN_EXTENSIONS) ??
    withExtension(join(target, "index"), MAIN_EXTENSIONS) ??
    index;
  if (found !== undefined) return { kind: "file", path: found };
  return BUN
    ? undefined
    : {
        kind: "missing",
        reason: `${manifestPath} "main" (${JSON.stringify(main)}) and its index do not exist`,
      };
}

/** The name and `./`-subpath of a bare specifier, or `undefined`. */
function splitSpecifier(
  spec: string,
): { name: string; subpath: string } | undefined {
  if (spec.startsWith(".") || spec.startsWith("/") || /^[a-z]:/i.test(spec)) {
    return undefined;
  }
  const parts = spec.split("/");
  const nameLength = spec.startsWith("@") ? 2 : 1;
  if (parts.length < nameLength || parts.slice(0, nameLength).includes("")) {
    return undefined;
  }
  return {
    name: parts.slice(0, nameLength).join("/"),
    subpath:
      parts.length > nameLength
        ? `./${parts.slice(nameLength).join("/")}`
        : ".",
  };
}

/** The package scope enclosing `dir`: the nearest `package.json`, inside the
 * nearest `node_modules` at most. */
function selfReference(
  dir: string,
  name: string,
  subpath: string,
): FreshResolution | undefined {
  for (;;) {
    const manifestPath = join(dir, "package.json");
    const manifest = readManifest(manifestPath);
    if (manifest.kind === "object") {
      const { name: own, exports: exp } = manifest.value;
      if (own !== name || !hasExports(exp)) return undefined;
      return resolveExports(dir, manifestPath, exp, subpath);
    }
    if (manifest.kind === "unusable") return undefined;
    const parent = dirname(dir);
    if (parent === dir || basename(dir) === "node_modules") return undefined;
    dir = parent;
  }
}

/**
 * Resolves the bare `spec` from `fromDir` the way the running runtime's
 * `require.resolve` would with an empty cache. A resolved file is reported by
 * its real path, as the runtime reports it.
 *
 * @internal
 */
export function resolveFresh(spec: string, fromDir: string): FreshResolution {
  const parsed = splitSpecifier(spec);
  if (!parsed) return { kind: "absent" };
  const { name, subpath } = parsed;
  const result =
    selfReference(fromDir, name, subpath) ?? walk(spec, name, subpath, fromDir);
  if (result.kind !== "file" || PRESERVE_SYMLINKS) return result;
  try {
    return { kind: "file", path: realpathSync(result.path) };
  } catch {
    // Gone between the stat and here; the load reports it.
    return result;
  }
}

function walk(
  spec: string,
  name: string,
  subpath: string,
  fromDir: string,
): FreshResolution {
  let dir = fromDir;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const found = lookIn(join(dir, "node_modules"), spec, name, subpath);
      if (found) return found;
    }
    const parent = dirname(dir);
    if (parent === dir) return { kind: "absent" };
    dir = parent;
  }
}

/** One `node_modules` directory; `undefined` moves on to the next. */
function lookIn(
  nodeModules: string,
  spec: string,
  name: string,
  subpath: string,
): FreshResolution | undefined {
  const pkgDir = join(nodeModules, ...name.split("/"));
  const manifestPath = join(pkgDir, "package.json");
  const manifest = readManifest(manifestPath);
  if (manifest.kind === "unusable" && !BUN) {
    return {
      kind: "invalid",
      manifest: manifestPath,
      reason: `invalid package config (${manifest.reason})`,
    };
  }
  if (manifest.kind === "object" && hasExports(manifest.value.exports)) {
    return resolveExports(
      pkgDir,
      manifestPath,
      manifest.value.exports,
      subpath,
    );
  }
  const base = resolve(nodeModules, spec);
  if (isFile(base)) return { kind: "file", path: base };
  const withExt = withExtension(base, MODULE_EXTENSIONS);
  if (withExt !== undefined) return { kind: "file", path: withExt };
  if (!isDirectory(base)) return undefined;
  return resolveDirectory(
    base,
    base === pkgDir ? manifest : readManifest(join(base, "package.json")),
  );
}
