/**
 * Loads a third-party target descriptor from the project, synchronously.
 *
 * **Unstable** (decision 129), like the contract it loads.
 *
 * This is `loadSidecar`'s mechanism (`scan.ts`) with two changes. It resolves
 * from the *project* (`createRequire` anchored at `fromDir/package.json`), not
 * from core, so a user's installed target package is found with no bundling
 * work. And it does not evict `require.cache` per call: a sidecar is edited
 * constantly, an installed target package is not, and evicting would hand back
 * a new descriptor object on every call. The package is re-evaluated only
 * when the target package's own `package.json` mtime or text changes, which is what
 * an install or upgrade does. Then its entry and every module under its
 * directory are re-evaluated, except modules under a nested `node_modules`
 * (other packages). A target without a manifest of its own (a project-local
 * `./targets/vue.js`, whose nearest manifest is the project's) re-evaluates
 * its entry file only: the project's directory is not the target's.
 *
 * Everything `loadSidecar` documents holds here too, because the loader is
 * synchronous and runs under whatever runtime loaded the tool: no top-level
 * `await`, explicit extensions on relative imports. The error restates the
 * constraint when the runtime's message identifies one.
 *
 * The caller then calls `descriptor.load?.(toolCore)` with the **tool's**
 * `@mxlang/core`; this module never calls `load`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse, resolve, sep } from "node:path";
import {
  type TargetDescriptor,
  TargetDescriptorError,
  validateDescriptor,
} from "./target-descriptor.ts";

/** @unstable */
export type TargetLoadErrorCode =
  | "not-found"
  | "load-failed"
  | "invalid-descriptor";

/**
 * A target specifier that could not become a descriptor. `message` is one
 * line with no stack, and does not say which config key named the specifier
 * (`mx.host` or `mx.target`): the caller owns that prefix.
 *
 * @unstable
 */
export class TargetLoadError extends Error {
  override readonly name = "TargetLoadError";
  readonly code: TargetLoadErrorCode;
  /** The specifier as the author wrote it. */
  readonly spec: string;
  /** The directory it was resolved from. */
  readonly fromDir: string;
  /** The resolved file, once resolution succeeded. */
  readonly path?: string;

  constructor(
    code: TargetLoadErrorCode,
    message: string,
    details: { spec: string; fromDir: string; path?: string; cause?: unknown },
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.code = code;
    this.spec = details.spec;
    this.fromDir = details.fromDir;
    if (details.path !== undefined) this.path = details.path;
  }
}

interface PackageStamp {
  manifest: string;
  mtimeMs: number;
  /** `undefined` when the manifest exists but cannot be read. */
  hash: string | undefined;
}

interface CacheEntry {
  /** Evidence from the nearest manifest; `undefined` when none was found. */
  stamp: PackageStamp | undefined;
  descriptor: TargetDescriptor;
}

const descriptors = new Map<string, CacheEntry>();
const moduleCache = createRequire(import.meta.url).cache;

/**
 * Drops every cached descriptor, and the runtime's module record for each, so
 * the next load re-evaluates the package. For tests and for a tool that wants
 * a clean slate.
 *
 * @unstable
 */
export function clearTargetDescriptorCache(): void {
  for (const resolved of descriptors.keys()) delete moduleCache[resolved];
  descriptors.clear();
}

/** The nearest `package.json` at or above `file`, with its mtime and content hash. */
function packageStamp(file: string): PackageStamp | undefined {
  let dir = dirname(file);
  const root = parse(dir).root;
  for (;;) {
    const manifest = join(dir, "package.json");
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(manifest).mtimeMs;
    } catch {
      // keep walking
    }
    if (mtimeMs !== undefined) {
      let hash: string | undefined;
      try {
        hash = createHash("sha256")
          .update(readFileSync(manifest))
          .digest("hex");
      } catch {
        // Do not mistake an unreadable nearest manifest for an absent one.
      }
      return { manifest, mtimeMs, hash };
    }
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

/**
 * The conditions a CommonJS `require` matches, as the running runtime's own
 * resolver does: `bun` only under Bun, never under Node.
 */
const CONDITIONS: ReadonlySet<string> = new Set([
  ...("bun" in process.versions ? ["bun"] : []),
  "node",
  "require",
  "default",
]);

/** A package whose manifest cannot be used: reported as `load-failed`. */
class InvalidPackage extends Error {
  readonly kind: "target" | "config";
  constructor(kind: "target" | "config", detail: string) {
    super(detail);
    this.kind = kind;
  }
}

/** Node's `invalidSegmentRegEx`, without the percent-encoded spellings. */
const INVALID_SEGMENT = /^(|\.|\.\.|node_modules)$/i;

/**
 * Resolves `target` (an `exports` value) for a CommonJS `require`, as Node's
 * PACKAGE_TARGET_RESOLVE does: a string must start with `./` and have no
 * empty, `.`, `..` or `node_modules` segment; an array takes the first entry
 * that resolves (an invalid one is remembered and thrown if none does); a
 * condition object takes the first key, in the package's own order, that this
 * runtime matches. `null` is an explicit "not exported".
 */
function exportsTarget(target: unknown): string | null | undefined {
  if (typeof target === "string") {
    if (
      !target.startsWith("./") ||
      target
        .slice(2)
        .split(/[\\/]/)
        .some((segment) => INVALID_SEGMENT.test(segment))
    ) {
      throw new InvalidPackage("target", `"${target}"`);
    }
    return target;
  }
  if (target === null || target === undefined) return target;
  if (Array.isArray(target)) {
    let invalid: InvalidPackage | undefined;
    for (const entry of target) {
      try {
        const found = exportsTarget(entry);
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
      const found = exportsTarget(value);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  throw new InvalidPackage("target", JSON.stringify(target) ?? String(target));
}

/**
 * The entry `exports` gives `subpath`, or `undefined` when it exports none.
 * `exports` is a subpath map when its keys start with `.` and a condition map
 * (the main entry's sugar) when none does; a mix is an invalid config, as in
 * Node. A string or array is the main entry's sugar.
 */
function exportsEntry(exp: unknown, subpath: string): unknown {
  if (typeof exp === "object" && exp !== null && !Array.isArray(exp)) {
    const keys = Object.keys(exp);
    const subpaths = keys.filter((key) => key.startsWith("."));
    if (subpaths.length > 0 && subpaths.length < keys.length) {
      throw new InvalidPackage(
        "config",
        '"exports" mixes subpath keys with condition keys',
      );
    }
    if (subpaths.length > 0) {
      return Object.hasOwn(exp, subpath)
        ? (exp as Record<string, unknown>)[subpath]
        : undefined;
    }
  }
  return subpath === "." ? exp : undefined;
}

/** Whether `file` is inside `dir` (a path-segment prefix, not a string one). */
function isInside(dir: string, file: string): boolean {
  return file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * A fresh resolution of a bare `spec` for when the runtime's resolver reported
 * a miss: both Bun and Node keep a miss once the project has a `node_modules`,
 * so a package installed after it is invisible to `require.resolve` for the
 * life of the process. This walks up from `fromDir` for
 * `node_modules/<name>/package.json` on the real filesystem and applies the
 * package's own `exports` (exact subpath keys; no wildcard patterns) or
 * `main`, which is enough for a target's entry point. An `exports` target is
 * statted verbatim, as Node does; only `main` (and a subpath of a package with
 * no `exports`) gets legacy extension and `index.js` probing. Returns
 * `undefined` when the package is not there, exports nothing for `spec`, or
 * its entry does not exist.
 *
 * Throws `TargetLoadError` `load-failed` for a package that is there but
 * unusable: a manifest that is not a JSON object, an invalid `exports` map, or
 * a target outside the package directory.
 */
function resolveFresh(spec: string, fromDir: string): string | undefined {
  if (spec.startsWith(".") || spec.startsWith("/") || /^[a-z]:/i.test(spec)) {
    return undefined;
  }
  const parts = spec.split("/");
  const nameLength = spec.startsWith("@") ? 2 : 1;
  if (parts.length < nameLength) return undefined;
  const name = parts.slice(0, nameLength).join("/");
  const subpath =
    parts.length > nameLength ? `./${parts.slice(nameLength).join("/")}` : ".";
  let dir: string;
  try {
    // The ancestors Node walks are those of the real directory.
    dir = realpathSync(fromDir);
  } catch {
    dir = fromDir;
  }
  for (;;) {
    const pkgDir = join(dir, "node_modules", ...name.split("/"));
    const manifestPath = join(pkgDir, "package.json");
    if (existsSync(manifestPath)) {
      const unusable = (reason: string, cause?: unknown) =>
        new TargetLoadError(
          "load-failed",
          `"${spec}" cannot be loaded: ${reason} in ${manifestPath}`,
          { spec, fromDir, cause },
        );
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (cause) {
        throw unusable(
          `invalid package config (${summary(messageOf(cause))})`,
          cause,
        );
      }
      if (
        manifest === null ||
        typeof manifest !== "object" ||
        Array.isArray(manifest)
      ) {
        throw unusable("invalid package config (not a JSON object)");
      }
      const { exports: exp, main } = manifest as {
        exports?: unknown;
        main?: unknown;
      };
      let relative: string | null | undefined;
      let probe = false;
      try {
        if (exp !== undefined && exp !== null) {
          relative = exportsTarget(exportsEntry(exp, subpath));
        } else if (subpath !== ".") {
          relative = subpath;
          probe = true;
        } else {
          relative = typeof main === "string" ? main : "index.js";
          probe = true;
        }
      } catch (cause) {
        if (!(cause instanceof InvalidPackage)) throw cause;
        throw unusable(`invalid package ${cause.kind} ${cause.message}`, cause);
      }
      if (relative === undefined || relative === null) return undefined;
      const base = resolve(pkgDir, relative);
      if (!isInside(pkgDir, base)) {
        throw unusable(
          `invalid package target "${relative}" leaves the package`,
        );
      }
      const candidates = probe
        ? [base, `${base}.js`, `${base}.cjs`, join(base, "index.js")]
        : [base];
      for (const candidate of candidates) {
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // try the next candidate
        }
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The constraints of `loadSidecar`, restated for a target package. */
function loadHint(message: string): string {
  if (message.includes("top-level await")) {
    return " — a target package is loaded synchronously, so it may not use top-level `await`";
  }
  if (message.includes("Cannot find module")) {
    return " — a target package's relative imports need explicit extensions (`./helper.ts`, not `./helper`)";
  }
  return "";
}

const firstLine = (message: string) => message.split("\n", 1)[0] as string;

/** A thrown value's text: modules may throw anything, not only an `Error`. */
function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    // `Object.create(null)`, or a `toString` that throws.
    return "a non-Error value was thrown";
  }
}

/** The first line of `message`, or a placeholder when that line is blank. */
function summary(message: string): string {
  return firstLine(message).trim() || "<no message>";
}

/** Whether `key` is under `prefix`, outside any nested `node_modules`. */
function ownedBy(prefix: string, key: string): boolean {
  return (
    key.startsWith(prefix) &&
    !key.slice(prefix.length).split(sep).includes("node_modules")
  );
}

/**
 * Drops the runtime's record of every module under `dir`, so a reloaded
 * package re-reads its internal files (`load: () => require("./compile.js")`)
 * and not only its entry file, and drops this loader's own cached
 * descriptors for the same files, so the two caches never disagree. Modules
 * under a nested `node_modules` are other packages and are left alone.
 */
function evictDirectory(cache: NodeJS.Dict<unknown>, dir: string): void {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  for (const key of Object.keys(cache)) {
    if (ownedBy(prefix, key)) delete cache[key];
  }
  for (const key of descriptors.keys()) {
    if (ownedBy(prefix, key)) descriptors.delete(key);
  }
}

/**
 * Whether the manifest at `manifest` belongs to the target package, rather
 * than to the project the target is loaded for: a manifest in `fromDir` or in
 * a directory above it is the project's own (a local `./targets/vue.js` has
 * no manifest of its own), and its directory holds far more than the target.
 */
function isPackageManifest(manifest: string, fromDir: string): boolean {
  const dir = dirname(manifest);
  return (
    dir !== fromDir && !fromDir.startsWith(dir.endsWith(sep) ? dir : dir + sep)
  );
}

/**
 * Resolves `spec` from `fromDir` (the directory of the nearest `package.json`),
 * requires it, and validates what it exports: the default export, else a named
 * `mxTarget`, else the module itself when it is the descriptor (a CommonJS
 * `module.exports = descriptor`).
 *
 * A relative `fromDir` is resolved against the cwd.
 *
 * Cached per resolved path and the target package's `package.json` mtime and
 * content hash (one manifest read/hash per hit, without retaining text, so a
 * same-tick edit is detected). An unreadable manifest is a stable state while
 * its path, mtime and readability are unchanged. When any changes, every
 * module under the package's directory (nested
 * `node_modules` excepted) is evicted and re-evaluated, not only the entry
 * file; when the manifest is the project's own (it is in `fromDir` or above
 * it) only the entry file is. A stale entry is dropped when its reload fails
 * or is invalid.
 * Failures are never cached: a failed load is re-evaluated on every call, so a
 * fix to any file it loaded (the entry, or a module the entry requires) is
 * picked up by the next call. A miss (`not-found`) is never cached by this
 * module either, but the runtime's resolver keeps a miss once the project has a
 * `node_modules` (Bun and Node alike), so a bare specifier it reports missing is
 * re-checked on disk: the package's own `exports`/`main` is applied directly, and
 * a target installed after a `not-found` loads on the next call, with no restart.
 * Throws `TargetLoadError`: `not-found` (does not resolve), `load-failed`
 * (throws while evaluating, or the package's manifest is unusable), `invalid-descriptor` (wrong shape, or a
 * `descriptorVersion` this mx does not support).
 *
 * @unstable
 */
export function loadTargetDescriptor(
  spec: string,
  fromDir: string,
): TargetDescriptor {
  fromDir = resolve(fromDir);
  const req = createRequire(join(fromDir, "package.json"));

  let resolved: string;
  try {
    resolved = req.resolve(spec);
  } catch (cause) {
    // The runtime's resolver may be serving a cached miss for a package
    // installed since; trust the filesystem before reporting not-found.
    const fresh = resolveFresh(spec, fromDir);
    if (fresh === undefined) {
      throw new TargetLoadError(
        "not-found",
        `"${spec}" cannot be resolved from ${fromDir}: ${summary(messageOf(cause))}`,
        { spec, fromDir, cause },
      );
    }
    // The real path, as `require.resolve` reports it, so the caches agree
    // whichever resolver found the file (a package manager may symlink).
    try {
      resolved = realpathSync(fresh);
    } catch {
      resolved = fresh;
    }
  }

  const stamped = packageStamp(resolved);
  const hit = descriptors.get(resolved);
  if (
    hit &&
    hit.stamp?.manifest === stamped?.manifest &&
    hit.stamp?.mtimeMs === stamped?.mtimeMs &&
    // Equal undefined hashes mean both observations were unreadable (or
    // absent), a stable state; a readability change still invalidates.
    hit.stamp?.hash === stamped?.hash
  ) {
    return hit.descriptor;
  }
  if (hit) {
    // The entry is stale whether or not the reload succeeds: a failure must
    // not leave it behind to drive another eviction on the next call.
    descriptors.delete(resolved);
    delete req.cache[resolved];
    if (stamped && isPackageManifest(stamped.manifest, fromDir)) {
      evictDirectory(req.cache, dirname(stamped.manifest));
    }
  }

  let module: unknown;
  try {
    module = req(resolved);
  } catch (cause) {
    // Bun keeps a module that failed to evaluate in its registry and re-throws
    // it after the file is fixed; Node forgets it. Drop it on both.
    delete req.cache[resolved];
    const message = messageOf(cause);
    throw new TargetLoadError(
      "load-failed",
      `"${spec}" failed to load: ${summary(message)}${loadHint(message)}. (${resolved})`,
      {
        spec,
        fromDir,
        path: resolved,
        cause,
      },
    );
  }

  const exported = module as
    | { default?: unknown; mxTarget?: unknown; descriptorVersion?: unknown }
    | null
    | undefined;
  const candidate =
    exported?.default ??
    exported?.mxTarget ??
    (exported && typeof exported === "object" && "descriptorVersion" in exported
      ? exported
      : undefined);

  let descriptor: TargetDescriptor;
  try {
    descriptor = validateDescriptor(candidate);
  } catch (cause) {
    if (!(cause instanceof TargetDescriptorError)) throw cause;
    // The module evaluated, so the runtime holds it even though we reject it:
    // drop it, or a fixed install would be served the same invalid exports.
    delete req.cache[resolved];
    const message =
      cause.kind === "version"
        ? `"${spec}" targets descriptor version ${cause.found}; this mx supports 0.`
        : `"${spec}" must export a target descriptor (default export or "mxTarget"): ${cause.message}. See the TargetDescriptor contract (unstable).`;
    throw new TargetLoadError("invalid-descriptor", message, {
      spec,
      fromDir,
      path: resolved,
      cause,
    });
  }

  descriptors.set(resolved, { stamp: stamped, descriptor });
  return descriptor;
}
