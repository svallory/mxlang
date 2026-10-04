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
import { readFileSync, statSync } from "node:fs";
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

/**
 * A load that failed (it threw, or exported no descriptor), kept under the
 * same evidence as a success plus the entry file's own mtime and size, so a
 * throwing module is not re-evaluated per file per edit, yet a fixed one
 * reloads: a reinstall changes the manifest, and a hand edit of a local
 * target changes the entry. `not-found` is never kept: resolving is cheap
 * and is exactly what a fresh install changes.
 */
const failures = new Map<
  string,
  {
    stamp: PackageStamp | undefined;
    entry: string;
    error: TargetLoadError;
  }
>();

/** Keeps `error` for the next call under the current evidence; returns it. */
function remember(
  resolved: string,
  stamp: PackageStamp | undefined,
  error: TargetLoadError,
): TargetLoadError {
  failures.set(resolved, { stamp, entry: entryStamp(resolved), error });
  return error;
}

/** The entry file's own mtime and size, `""` if it cannot be read. */
function entryStamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
}
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
  for (const resolved of failures.keys()) delete moduleCache[resolved];
  descriptors.clear();
  failures.clear();
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
 * Failures are never cached, so a fixed install is picked up by the next call.
 * Throws `TargetLoadError`: `not-found` (does not resolve), `load-failed`
 * (throws while evaluating), `invalid-descriptor` (wrong shape, or a
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
    throw new TargetLoadError(
      "not-found",
      `"${spec}" cannot be resolved from ${fromDir}: ${summary(messageOf(cause))}`,
      { spec, fromDir, cause },
    );
  }

  const stamped = packageStamp(resolved);
  const failed = failures.get(resolved);
  if (failed) {
    if (
      failed.error.spec === spec &&
      failed.stamp?.manifest === stamped?.manifest &&
      failed.stamp?.mtimeMs === stamped?.mtimeMs &&
      failed.stamp?.hash === stamped?.hash &&
      failed.entry === entryStamp(resolved)
    ) {
      throw failed.error;
    }
    failures.delete(resolved);
    delete req.cache[resolved];
    if (stamped && isPackageManifest(stamped.manifest, fromDir)) {
      evictDirectory(req.cache, dirname(stamped.manifest));
    }
  }
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
    throw remember(
      resolved,
      stamped,
      new TargetLoadError(
        "load-failed",
        `"${spec}" failed to load: ${summary(message)}${loadHint(message)}. (${resolved})`,
        {
          spec,
          fromDir,
          path: resolved,
          cause,
        },
      ),
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
    throw remember(
      resolved,
      stamped,
      new TargetLoadError("invalid-descriptor", message, {
        spec,
        fromDir,
        path: resolved,
        cause,
      }),
    );
  }

  descriptors.set(resolved, { stamp: stamped, descriptor });
  return descriptor;
}
