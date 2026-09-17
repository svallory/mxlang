/**
 * The cached front door to `scanCustomTags`, plus the Marko taglib-lifetime
 * fix the P1 review left to this phase.
 *
 * Two caches with different keys, because two different things are expensive:
 *
 * 1. **The scan**, keyed on the directory a file lives in. Every integration
 *    scans once per compiled file, and a project compiles many files from one
 *    directory, so an uncached scan would re-read every `tags/` directory and
 *    re-parse every sidecar per file. Invalidation is by the evidence the
 *    scan itself recorded (spec §4): a directory's entry list, every tag
 *    file's mtime, and the `package.json` that supplied `mx.tags`. A stale
 *    entry is *detected*, not merely expired, so an editor that never restarts
 *    still recompiles against the tag an author just saved.
 *
 * 2. **The tag map identity**, keyed on the set of tags a scan produced.
 *    `@marko/compiler` caches its taglib lookups process-wide and never
 *    evicts: `loadedTranslatorsTaglibs` is keyed on the *translator object*
 *    and `lookupCache` on the sorted taglib ids (measured in 5.42.5,
 *    `chunk-src.js`'s `buildLookup`). A long-lived language server compiling
 *    an edited file over and over would therefore add one live entry per
 *    compile. Returning the *same map object* for an unchanged tag set makes
 *    the taglib id — which P1 derives from that set — stable, so the compiler
 *    reuses one lookup instead of accumulating them; and when the set does
 *    change, `evictTaglibCaches` drops the entries the old set left behind.
 *
 * Both caches are process-global on purpose. The whole point is that the
 * language server, `mx-tsc` and a Vite dev server each hold one long-lived
 * process; a per-call cache would be no cache at all.
 */

import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { CustomTag } from "./custom-tags.ts";
import { type ScanOptions, type ScanResult, scanCustomTags } from "./scan.ts";

const require = createRequire(import.meta.url);

interface CacheEntry {
  result: ScanResult;
  /** Directory entry lists as they were when scanned, for add/remove. */
  listings: Map<string, string>;
  /** `package.json` mtimes, for an `mx.tags` change. */
  manifests: Map<string, number>;
}

/** A listing value no real directory can produce, so "absent" is a state. */
const MISSING_DIR = "<missing>";

const scans = new Map<string, CacheEntry>();

/**
 * Tag maps kept alive by their signature, so an unchanged tag set hands back
 * one object and therefore one Marko taglib id. See the module doc.
 */
const maps = new Map<string, Record<string, CustomTag>>();

/** The signature of the tag set the last handed-out map represented. */
let liveSignature: string | undefined;

function listingOf(dir: string): string {
  try {
    return readdirSync(dir).sort().join("\0");
  } catch {
    // A directory that does not exist has a stable "missing" listing, so its
    // later creation is a change this detects rather than misses.
    return MISSING_DIR;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

function snapshot(result: ScanResult): CacheEntry {
  const listings = new Map<string, string>();
  for (const dir of result.directories) listings.set(dir, listingOf(dir));
  const manifests = new Map<string, number>();
  for (const file of result.packageFiles) manifests.set(file, mtimeOf(file));
  return { result, listings, manifests };
}

/**
 * Whether `entry` still describes the filesystem.
 *
 * Checks exactly the three things the spec names as invalidating: an add or
 * remove in a scanned directory, a tag file's mtime, and a `package.json`
 * carrying `mx.tags`.
 */
function isFresh(entry: CacheEntry): boolean {
  for (const [dir, listing] of entry.listings) {
    if (listingOf(dir) !== listing) return false;
  }
  for (const [file, mtimeMs] of entry.manifests) {
    if (mtimeOf(file) !== mtimeMs) return false;
  }
  for (const file of entry.result.files) {
    if (mtimeOf(file.path) !== file.mtimeMs) return false;
  }
  return true;
}

/**
 * The parser-facing identity of a tag set: the names, where each came from,
 * and each one's `parseOptions`.
 *
 * This is what Marko's taglib id is derived from, so two scans agreeing here
 * may share one lookup. It deliberately excludes the sidecars' *contents*,
 * which are loaded lazily and may never be read at all.
 */
function parserSignatureOf(result: ScanResult): string {
  return [...result.tags.keys()]
    .sort()
    .map((name) => {
      const tag = result.tags.get(name);
      return `${name}|${tag?.template ?? ""}|${tag?.sidecar ?? ""}|${JSON.stringify(tag?.parseOptions ?? null)}`;
    })
    .join("\n");
}

/**
 * The identity of one *loaded* tag set: the above, plus every tag file's
 * mtime.
 *
 * Two different questions hide behind "is this the same tag set", and
 * conflating them is a real bug rather than a nicety. Marko's taglib only
 * cares about names and parse options, so an edit that changes neither may
 * keep its lookup. But a memoized `CustomTag` also holds the sidecar module
 * it already loaded, so reusing that object after an edit serves the *old*
 * hooks — measured: editing a `transform` changed nothing about the compiled
 * output until this key gained the mtimes.
 */
function loadedSignatureOf(result: ScanResult): string {
  const files = [...result.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}@${file.mtimeMs}`)
    .join("\n");
  return `${parserSignatureOf(result)}\n--\n${files}`;
}

/**
 * Drops `@marko/compiler`'s taglib caches.
 *
 * Called only when the live tag set actually changes, never per compile: the
 * caches are what make repeated compilation fast, and clearing them on every
 * call would trade one leak for a much larger slowdown.
 */
export function evictTaglibCaches(): void {
  try {
    const { taglib } = require("@marko/compiler");
    taglib?.clearCaches?.();
  } catch {
    // The compiler is a lazy dependency of this package; a caller that never
    // loaded it has no caches to clear.
  }
}

/**
 * Returns the custom tags callable from `filePath`, scanning at most once per
 * directory per filesystem state.
 *
 * The returned map is shared: callers must not mutate it. It is the same
 * object across calls while the tag set is unchanged, which is what keeps
 * Marko's taglib lookup from growing (module doc, point 2).
 */
export function getCustomTags(
  filePath: string,
  options: ScanOptions = {},
): Record<string, CustomTag> {
  return scanCached(filePath, options).customTags;
}

/**
 * The cached scan itself, for a caller that needs the evidence as well as the
 * map — an integration wiring up its own file watcher, for instance.
 */
export function scanCached(
  filePath: string,
  options: ScanOptions = {},
): ScanResult {
  const key = `${dirname(resolve(filePath))}\0${options.stopAt ?? ""}\0${options.host ?? ""}`;
  const cached = scans.get(key);
  if (cached && isFresh(cached)) return cached.result;

  const result = scanCustomTags(filePath, options);
  const loadedSignature = loadedSignatureOf(result);
  const parserSignature = parserSignatureOf(result);

  // Reuse the previously handed-out map only when the tag files are byte-for-
  // byte the same run of files, so a memoized sidecar can never outlive an
  // edit to it.
  const existing = maps.get(loadedSignature);
  if (existing) {
    result.customTags = existing;
  } else {
    if (liveSignature !== undefined && liveSignature !== parserSignature) {
      // The *parser-facing* set changed, so the entries the old one left in
      // Marko's caches can never be hit again. An edit that changed only a
      // hook body leaves those entries valid and does not evict them.
      evictTaglibCaches();
    }
    // Only one loaded map per parser-facing set is useful: an older one
    // describes files that have since been edited.
    for (const key of maps.keys()) {
      if (key.startsWith(`${parserSignature}\n--\n`)) maps.delete(key);
    }
    maps.set(loadedSignature, result.customTags);
    liveSignature = parserSignature;
  }

  scans.set(key, snapshot(result));
  return result;
}

/** Drops every cached scan. For tests and for an editor's "restart" command. */
export function clearScanCache(): void {
  scans.clear();
  maps.clear();
  liveSignature = undefined;
}

/** How many distinct tag-set maps are live. A test asserts this stays bounded. */
export function liveTagMapCount(): number {
  return maps.size;
}
