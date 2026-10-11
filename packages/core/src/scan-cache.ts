/**
 * The cached front door to `scanCustomTags`.
 *
 * Two caches with different keys, because two different things are expensive:
 *
 * 1. **The scan**, keyed on the directory a file lives in. Every integration
 *    scans once per compiled file, and a project compiles many files from one
 *    directory, so an uncached scan would re-read every `tags/` directory and
 *    re-parse every sidecar per file. Invalidation is by the evidence the
 *    scan itself recorded (spec §4): a directory's entry list, every tag
 *    file's stamp, the `package.json` that supplied `mx.tags`, and every
 *    project dialect's `package.json` (its `tagDirs` and claims decide what
 *    the scan reads). A stamp is `(mtimeMs, ctimeMs, size, ino)` plus a
 *    content hash only for a *racy* file, one changed within
 *    {@link RACY_WINDOW_MS} of the snapshot (git's index rule). A stale entry
 *    is *detected*, not merely expired, so an editor that never restarts
 *    still recompiles against the tag an author just saved.
 *
 *    A racy sidecar's hash is of the bytes the scan read, so a same-tick
 *    edit between that read and the snapshot is stale too. Known gaps: an
 *    `mx.contracts` module is read by the module loader, not the scan, so
 *    such an edit to one is caught only by its mtime; and see
 *    {@link RACY_WINDOW_MS} for a filesystem whose clock lags this one.
 *
 *    The key gains the caller's dialect: an MX file and a dialect file in one
 *    directory scan different tag directories.
 *
 * 2. **The tag map identity**, keyed on the tag files a scan loaded. An
 *    unchanged tag set hands back the *same map object*, whose `CustomTag`s
 *    keep the sidecar modules they already loaded, so a long-lived process
 *    compiling an edited file over and over neither reloads every sidecar
 *    nor accumulates one map per compile. Only the newest map of a
 *    parser-facing set (names, origins, `parseOptions`) is kept.
 *
 * Both caches are process-global on purpose. The whole point is that the
 * language server, `mx-tsc` and a Vite dev server each hold one long-lived
 * process; a per-call cache would be no cache at all.
 *
 * Until PR 6 slice S3b the map identity also kept `@marko/compiler`'s
 * process-wide taglib lookup cache from growing, and a changed set evicted
 * it (`evictTaglibCaches`). Core builds no Marko lookup since S3a.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isTranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import { dialectRouter } from "./dialect-discovery.ts";
import { findNearestPackageJson } from "./host-policy.ts";
import { mxConfigGeneration, mxConfigSearchPaths } from "./mx-config.ts";
import {
  CORE_TAG_DISCOVERY,
  callerTagDiscovery,
  dottedTagFileDiagnostics,
  type ScanDiagnostic,
  type ScanOptions,
  type ScanResult,
  scannedHashOf,
  scanWithDiscovery,
  type TagDiscovery,
  tagDiscoveryOf,
} from "./scan.ts";

interface CacheEntry {
  result: ScanResult;
  /** {@link mxConfigGeneration} when scanned: a provided config is no file. */
  configGeneration: number;
  /** Directory entry lists as they were when scanned, for add/remove. */
  listings: Map<string, string>;
  /**
   * `package.json` (the project's and each dialect's) and MX config stamps.
   * mtime alone misses an edit that pins the mtime or lands in the same
   * filesystem tick (Linux < 6.13 stamps at jiffy granularity): ctime catches
   * the first, the racy hash the second.
   */
  manifests: Map<string, FileStamp>;
  /** Only the tag files the scan already tracks, including sidecars. */
  files: Map<string, FileStamp>;
}

/**
 * What a file looked like when scanned. `missing` for a file that did not
 * exist (or a stamp poisoned by an edit racing the scan, which can never
 * match again).
 */
type FileStamp =
  | {
      /**
       * Fractional milliseconds, not `bigint` nanoseconds: a `bigint` stat
       * measured 2.3x slower under Bun (2.24 vs 0.97 ms for 1200 files),
       * and a double still resolves ~0.25 µs at today's epoch, far below
       * the racy window that covers what it cannot tell apart.
       */
      mtimeMs: number;
      ctimeMs: number;
      size: number;
      ino: number;
      /** Only for a racy file; `undefined` when it could not be read. */
      hash?: string | undefined;
    }
  | { missing: true; poisoned?: true };

/**
 * How close to the snapshot a file's mtime or ctime may be and still be
 * changed again without moving either: FAT's 2 s granularity, the coarsest
 * in use, plus 1 s of margin for a filesystem whose clock runs behind this
 * process's. A timestamp in the future is racy too.
 *
 * Known gap: the window compares filesystem timestamps with this process's
 * clock (git compares with its index file's own mtime instead). On a
 * network filesystem whose clock lags by more than the margin and whose
 * granularity is coarse, a just-written file reads as settled, and a second
 * same-size edit inside one tick keeps every stamp field: that edit is
 * missed until the next change.
 */
const RACY_WINDOW_MS = 3000;
let racyWindowMs = RACY_WINDOW_MS;

/** A listing value no real directory can produce, so "absent" is a state. */
const MISSING_DIR = "<missing>";

const scans = new Map<string, CacheEntry>();

/**
 * How a directory's file names route to a dialect's discovery, plus the
 * files that routing read. A hit trusts the memo only because every cache
 * entry carries those files as evidence: a change that could re-route the
 * caller makes the entry its guess points at stale, and the miss rebuilds
 * the memo. A directory whose routing failed has no memo (every lookup
 * routes afresh), so a dependency installed later is seen.
 */
interface Routing {
  route(name: string): TagDiscovery;
  /** The project's `package.json`, its dialects' and MX config places. */
  evidence: string[];
}

const routings = new Map<string, Routing>();

/**
 * Tag maps kept alive by their signature, so an unchanged tag set hands back
 * one object. See the module doc.
 */
const maps = new Map<string, Record<string, CustomTag>>();

function listingOf(dir: string): string {
  try {
    return readdirSync(dir).sort().join("\0");
  } catch {
    // A directory that does not exist has a stable "missing" listing, so its
    // later creation is a change this detects rather than misses.
    return MISSING_DIR;
  }
}

/** The stat part of a stamp, or `missing`. */
function statOf(path: string): FileStamp {
  let stats: ReturnType<typeof statSync> | undefined;
  try {
    stats = statSync(path, { throwIfNoEntry: false });
  } catch {
    stats = undefined;
  }
  if (stats === undefined) return { missing: true };
  return {
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
    ino: stats.ino,
  };
}

/** Whether a file stamped at `stamp` could still change without moving it. */
function isRacy(stamp: FileStamp, nowMs: number): boolean {
  if ("missing" in stamp) return false;
  return Math.max(stamp.mtimeMs, stamp.ctimeMs) >= nowMs - racyWindowMs;
}

/**
 * Stamps `path`: stat first, then the content of a racy file, so a write
 * racing the stamp reads as stale.
 */
function stampOf(path: string, nowMs: number): FileStamp {
  const stamp = statOf(path);
  if (isRacy(stamp, nowMs)) return { ...stamp, hash: hashOf(path) };
  return stamp;
}

function stampsMatch(stamp: FileStamp, now: FileStamp): boolean {
  if ("missing" in stamp || "missing" in now) {
    return (
      "missing" in stamp &&
      "missing" in now &&
      stamp.poisoned === undefined &&
      now.poisoned === undefined
    );
  }
  return (
    stamp.mtimeMs === now.mtimeMs &&
    stamp.ctimeMs === now.ctimeMs &&
    stamp.size === now.size &&
    stamp.ino === now.ino
  );
}

/** Whether `stamp` still describes `path`, re-reading a racy file. */
function stampIsFresh(path: string, stamp: FileStamp, nowMs: number): boolean {
  if (!stampsMatch(stamp, statOf(path))) return false;
  if ("missing" in stamp || !("hash" in stamp)) return true;
  if (hashOf(path) !== stamp.hash) return false;
  // Verified now and no longer racy: a later change moves the stat.
  if (!isRacy(stamp, nowMs)) delete stamp.hash;
  return true;
}

function hashOf(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * The routing of `dir`'s file names, or `undefined` when it failed (the
 * compile reports why). A manifest edit can change which directories the
 * scan reads and which files it skips, so the project's `package.json`,
 * every dialect's and MX config's search places are all evidence.
 */
function routingOf(dir: string): Routing | undefined {
  let router: ReturnType<typeof dialectRouter>;
  try {
    router = dialectRouter(dir);
  } catch {
    return undefined;
  }
  const project = findNearestPackageJson(dir)?.file;
  const evidence = [
    ...(project === undefined ? [] : [project]),
    ...mxConfigSearchPaths(dir),
    ...(router?.dialects ?? []).map((dialect) => dialect.packageFile),
  ];
  if (router === undefined) {
    return { route: () => CORE_TAG_DISCOVERY, evidence };
  }
  const known = router;
  return {
    route: (name) => {
      try {
        return tagDiscoveryOf(known.route(name)?.dialect);
      } catch {
        // A clash: the compile reports it; the project file is evidence.
        return CORE_TAG_DISCOVERY;
      }
    },
    evidence,
  };
}

function snapshot(
  result: ScanResult,
  routingEvidence: readonly string[],
): CacheEntry {
  const nowMs = Date.now();
  const listings = new Map<string, string>();
  for (const dir of result.directories) listings.set(dir, listingOf(dir));
  const manifests = new Map<string, FileStamp>();
  for (const file of [
    ...result.packageFiles,
    ...(result.configFiles ?? []),
    ...routingEvidence,
  ]) {
    manifests.set(file, stampOf(file, nowMs));
  }
  const files = new Map<string, FileStamp>();
  for (const file of result.files) {
    // The scan recorded mtime before reading sidecar options. A stamp that
    // no longer agrees with it saw an intervening edit: poison it, so the
    // next lookup rescans rather than trusting what the scan never read.
    const stamp = stampOf(file.path, nowMs);
    const agrees = !("missing" in stamp) && stamp.mtimeMs === file.mtimeMs;
    // A racy file keeps the hash of the bytes the scan read, not of what is
    // there now: a same-tick edit between the two then reads as stale.
    const scanned = scannedHashOf(file);
    if (agrees && "hash" in stamp && scanned !== undefined) {
      stamp.hash = scanned;
    }
    files.set(file.path, agrees ? stamp : { missing: true, poisoned: true });
  }
  return {
    result,
    configGeneration: mxConfigGeneration(),
    listings,
    manifests,
    files,
  };
}

/**
 * Whether `entry` still describes the filesystem.
 *
 * Checks exactly the things the spec names as invalidating: an add or
 * remove in a scanned directory (its entries, not its mtime), a tag file,
 * and a `package.json` or MX config search place (each file by its stamp).
 * An unchanged hit stats each tracked file once and reads only racy ones;
 * directory listings were already content-aware. Snapshots retain only
 * fixed-size stamps, not file contents duplicated per directory.
 */
function isFresh(entry: CacheEntry): boolean {
  if (entry.configGeneration !== mxConfigGeneration()) return false;
  for (const [dir, listing] of entry.listings) {
    if (listingOf(dir) !== listing) return false;
  }
  const nowMs = Date.now();
  for (const [file, stamp] of entry.manifests) {
    if (!stampIsFresh(file, stamp, nowMs)) return false;
  }
  for (const [file, stamp] of entry.files) {
    if (!stampIsFresh(file, stamp, nowMs)) return false;
  }
  return true;
}

/**
 * The parser-facing identity of a tag set: the names, where each came from,
 * and each one's `parseOptions`: what the tag table reads of it. It
 * deliberately excludes the sidecars' *contents*, whose hooks are evaluated
 * lazily.
 */
function parserSignatureOf(result: ScanResult): string {
  return [...result.tags.keys()]
    .sort()
    .map((name) => {
      const tag = result.tags.get(name);
      return `${name}|${tag?.template ?? ""}|${tag?.sidecar ?? ""}|${tag?.module ?? ""}|${tag?.tagFile ?? ""}|${tag?.dialect ?? ""}|${JSON.stringify(tag?.parseOptions ?? null)}`;
    })
    .join("\n");
}

/**
 * The identity of one *loaded* tag set: the above, plus every tag file's
 * stamp. Reuse the stamps computed by the snapshot rather than reading the
 * files a second time to build this signature.
 *
 * Two different questions hide behind "is this the same tag set", and
 * conflating them is a real bug rather than a nicety. The tag table only
 * reads names and parse options, so an edit that changes neither leaves the
 * parse alone. But a memoized `CustomTag` also holds the sidecar module
 * it already loaded, so reusing that object after an edit serves the *old*
 * hooks — measured: editing a `transform` changed nothing about the compiled
 * output until this key gained the mtimes. Text hashes also distinguish an
 * edit within one mtime tick, even when parser-facing options do not change.
 */
function loadedSignatureOf(entry: CacheEntry): string {
  const files = [...entry.files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, stamp]) => JSON.stringify([path, printableStamp(stamp)]))
    .join("\n");
  return `${parserSignatureOf(entry.result)}\n--\n${files}`;
}

/**
 * Returns the custom tags callable from `filePath`, scanning at most once per
 * directory per filesystem state.
 *
 * The returned map is shared: callers must not mutate it. It is the same
 * object across calls while the tag set is unchanged (module doc, point 2).
 */
export function getCustomTags(
  filePath: string,
  options: ScanOptions,
): Record<string, CustomTag> {
  return scanCached(filePath, options).customTags;
}

/**
 * Reports each of `diagnostics` through `sink` at most once per distinct
 * `file`+`message` pair recorded in `reported` — the same de-dup key
 * `@mxlang/vite-plugin` and `@mxlang/typescript-plugin` already used inline
 * (independently, before this was pulled out): a scan is re-run on every
 * compile of every file in a package, so without de-dup one misconfigured
 * `package.json` would print (or re-diagnose) its warning once per compiled
 * file rather than once.
 *
 * A caller owns its own `reported` set — its lifetime is the caller's
 * (per language-plugin instance, per dev-server process, for the lifetime of
 * a one-shot CLI run) — and its own `sink`, since "surface a warning" means
 * something different per integration: `console.warn` for a loader or CLI, a
 * pushed diagnostic for a language plugin, an LSP publish for the language
 * server.
 */
export function reportScanDiagnostics(
  diagnostics: readonly ScanDiagnostic[],
  reported: Set<string>,
  sink: (diagnostic: ScanDiagnostic) => void,
): void {
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.file}\u0000${diagnostic.message}`;
    if (reported.has(key)) continue;
    reported.add(key);
    sink(diagnostic);
  }
}

/**
 * The cached scan itself, for a caller that needs the evidence as well as the
 * map — an integration wiring up its own file watcher, for instance.
 */
export function scanCached(filePath: string, options: ScanOptions): ScanResult {
  // The key is deliberately unchanged by `options.targets`: the lookup is
  // which file-kind segments exist, not which files are found. Diagnostic
  // wording is derived per caller from cached filename evidence.
  // Folding it in would hand the same tag set a second identity per call,
  // which is the exact leak the tag-map cache below exists to prevent.
  const filter =
    options.host === undefined
      ? "unfiltered"
      : options.host === null
        ? "no-host-key"
        : `host:${options.host}`;
  // The caller's dialect picks which tag directories and kinds are scanned,
  // so it is part of the key. A hit routes by the directory's memo
  // (`routings`); a miss routes afresh and replaces the memo.
  const dir = dirname(resolve(filePath));
  const name = basename(filePath);
  const prefix = `${dir}\0${options.stopAt ?? ""}\0${filter}\0`;
  const memo = routings.get(dir);
  if (memo) {
    const guessed = scans.get(prefix + memo.route(name).id);
    if (guessed && isFresh(guessed)) return hit(guessed, options);
  }
  const routing = routingOf(dir);
  if (routing) routings.set(dir, routing);
  else routings.delete(dir);
  const discovery = routing
    ? routing.route(name)
    : callerTagDiscovery(filePath);
  const key = prefix + discovery.id;
  const cached = scans.get(key);
  if (cached && isFresh(cached)) return hit(cached, options);

  let result: ScanResult;
  try {
    result = scanWithDiscovery(filePath, options, discovery);
  } catch (error) {
    // Discovery stopped early, so partial evidence cannot authoritatively
    // replace the last complete scan's watcher edges. Retain those inputs
    // alongside the offending file; never cache a failed scan as empty.
    if (cached && isTranslateError(error)) {
      error.dependencies = [
        ...new Set([
          ...(error.dependencies ?? []),
          ...cached.result.packageFiles,
          ...cached.result.files.map((file) => file.path),
        ]),
      ];
    }
    throw error;
  }
  const entry = snapshot(result, routing?.evidence ?? []);
  const loadedSignature = loadedSignatureOf(entry);
  const parserSignature = parserSignatureOf(result);

  // Reuse the previously handed-out map only when the tag files are byte-for-
  // byte the same run of files, so a memoized sidecar can never outlive an
  // edit to it.
  const existing = maps.get(loadedSignature);
  if (existing) {
    result.customTags = existing;
  } else {
    // Only one loaded map per parser-facing set is useful: an older one
    // describes files that have since been edited.
    for (const key of maps.keys()) {
      if (key.startsWith(`${parserSignature}\n--\n`)) maps.delete(key);
    }
    maps.set(loadedSignature, result.customTags);
  }

  // Do not cache the first caller's dotted-filename wording. Keep the file
  // evidence already captured above, without reading the snapshot twice.
  const dottedPositions = new Set(
    result.dottedTagFiles?.map((file) => file.diagnosticIndex),
  );
  if (dottedPositions.size > 0) {
    entry.result = {
      ...result,
      diagnostics: result.diagnostics.filter(
        (_, index) => !dottedPositions.has(index),
      ),
    };
  }
  scans.set(key, entry);
  return result;
}

/** A fresh entry's result, with dotted-name wording derived per caller. */
function hit(cached: CacheEntry, options: ScanOptions): ScanResult {
  const evidence = cached.result.dottedTagFiles ?? [];
  return evidence.length === 0
    ? cached.result
    : {
        ...cached.result,
        diagnostics: dottedTagFileDiagnostics(
          evidence,
          options.targets,
          cached.result.diagnostics,
        ),
      };
}

/**
 * Stamps `path` as a snapshot taken at `nowMs` would, and checks a stamp as
 * a lookup at `nowMs` would: the freshness rule itself, field by field, for
 * tests (not public API).
 */
export const stampForTests = {
  of: (path: string, nowMs: number): FileStamp => stampOf(path, nowMs),
  isFresh: (path: string, stamp: FileStamp, nowMs: number): boolean =>
    stampIsFresh(path, stamp, nowMs),
};

/**
 * Snapshots `result` as a cache miss would, and answers whether a lookup
 * would still trust it: the snapshot's own rules (poisoning, the scanned
 * hash) end to end, for tests (not public API).
 */
export function snapshotFreshForTests(result: ScanResult): () => boolean {
  const entry = snapshot(result, []);
  return () => isFresh(entry);
}

/** Drops every cached scan. For tests and for an editor's "restart" command. */
export function clearScanCache(): void {
  scans.clear();
  routings.clear();
  maps.clear();
}

/** A copy of a stamp, so a test cannot mutate the cache. */
function printableStamp(stamp: FileStamp): object {
  return { ...stamp };
}

/** Copies of file evidence only, for testing snapshot retention (not public API). */
export function scanCacheStampsForTests(): object[] {
  return [...scans.values()].flatMap((entry) =>
    [...entry.files.values(), ...entry.manifests.values()].map(printableStamp),
  );
}

/** Each evidence path with its printable stamp, for tests (not public API). */
export function scanCacheEvidenceForTests(): Array<[string, object]> {
  return [...scans.values()].flatMap((entry) =>
    [...entry.files, ...entry.manifests].map(
      ([path, stamp]): [string, object] => [path, printableStamp(stamp)],
    ),
  );
}

/**
 * Sets the racy window and returns the previous one, for tests that need a
 * file to be non-racy without waiting out the window (not public API).
 */
export function setRacyWindowForTests(ms: number): number {
  const previous = racyWindowMs;
  racyWindowMs = ms;
  return previous;
}

/** How many distinct tag-set maps are live. A test asserts this stays bounded. */
export function liveTagMapCount(): number {
  return maps.size;
}
