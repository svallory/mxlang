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
 *    file's mtime and content hash, and the `package.json` that supplied `mx.tags`. A stale
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

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { CustomTag } from "./custom-tags.ts";
import {
  dottedTagFileDiagnostics,
  type ScanDiagnostic,
  type ScanOptions,
  type ScanResult,
  scanCustomTags,
} from "./scan.ts";

const require = createRequire(import.meta.url);

interface CacheEntry {
  result: ScanResult;
  /** Directory entry lists as they were when scanned, for add/remove. */
  listings: Map<string, string>;
  /**
   * `package.json` mtime and content hash, for an `mx.tags` change. Content is
   * what makes a hit trustworthy: mtime alone misses an edit that pins the mtime
   * or lands in the same filesystem tick (Linux < 6.13 stamps at jiffy
   * granularity).
   */
  manifests: Map<string, FileStamp>;
  /** Only the tag files the scan already tracks, including sidecars. */
  files: Map<string, FileStamp>;
}

interface FileStamp {
  mtimeMs: number;
  /** `undefined` when the file could not be read. */
  hash: string | undefined;
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

function hashOf(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function snapshot(result: ScanResult): CacheEntry {
  const listings = new Map<string, string>();
  for (const dir of result.directories) listings.set(dir, listingOf(dir));
  const manifests = new Map<string, FileStamp>();
  for (const file of result.packageFiles) {
    // mtime before content: a write racing this snapshot then reads as stale.
    manifests.set(file, { mtimeMs: mtimeOf(file), hash: hashOf(file) });
  }
  const files = new Map<string, FileStamp>();
  for (const file of result.files) {
    // The scan recorded mtime before reading sidecar options; keep that stamp
    // rather than a later stat that could hide an intervening edit.
    files.set(file.path, { mtimeMs: file.mtimeMs, hash: hashOf(file.path) });
  }
  return { result, listings, manifests, files };
}

/**
 * Whether `entry` still describes the filesystem.
 *
 * Checks exactly the three things the spec names as invalidating: an add or
 * remove in a scanned directory (its entries, not its mtime), a tag file,
 * and a `package.json` carrying `mx.tags` (both files checked by mtime and
 * content hash). An unchanged hit reads and hashes each tracked tag file and
 * manifest once; directory listings were already content-aware. Snapshots
 * retain only fixed-size hashes, not file contents duplicated per directory.
 */
function isFresh(entry: CacheEntry): boolean {
  for (const [dir, listing] of entry.listings) {
    if (listingOf(dir) !== listing) return false;
  }
  for (const [file, stamp] of entry.manifests) {
    if (mtimeOf(file) !== stamp.mtimeMs) return false;
    if (hashOf(file) !== stamp.hash) return false;
  }
  for (const [file, stamp] of entry.files) {
    if (mtimeOf(file) !== stamp.mtimeMs) return false;
    if (hashOf(file) !== stamp.hash) return false;
  }
  return true;
}

/**
 * The parser-facing identity of a tag set: the names, where each came from,
 * and each one's `parseOptions`.
 *
 * This is what Marko's taglib id is derived from, so two scans agreeing here
 * may share one lookup. It deliberately excludes the sidecars' *contents*,
 * whose hooks are evaluated lazily.
 */
function parserSignatureOf(result: ScanResult): string {
  return [...result.tags.keys()]
    .sort()
    .map((name) => {
      const tag = result.tags.get(name);
      return `${name}|${tag?.template ?? ""}|${tag?.sidecar ?? ""}|${tag?.module ?? ""}|${JSON.stringify(tag?.parseOptions ?? null)}`;
    })
    .join("\n");
}

/**
 * The identity of one *loaded* tag set: the above, plus every tag file's
 * mtime and content hash. Reuse the hashes computed by the snapshot rather
 * than reading or hashing the files a second time to build this signature.
 *
 * Two different questions hide behind "is this the same tag set", and
 * conflating them is a real bug rather than a nicety. Marko's taglib only
 * cares about names and parse options, so an edit that changes neither may
 * keep its lookup. But a memoized `CustomTag` also holds the sidecar module
 * it already loaded, so reusing that object after an edit serves the *old*
 * hooks — measured: editing a `transform` changed nothing about the compiled
 * output until this key gained the mtimes. Text hashes also distinguish an
 * edit within one mtime tick, even when parser-facing options do not change.
 */
function loadedSignatureOf(entry: CacheEntry): string {
  const files = [...entry.files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, stamp]) =>
      JSON.stringify([path, stamp.mtimeMs, stamp.hash ?? null]),
    )
    .join("\n");
  return `${parserSignatureOf(entry.result)}\n--\n${files}`;
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
  const key = `${dirname(resolve(filePath))}\0${options.stopAt ?? ""}\0${filter}`;
  const cached = scans.get(key);
  if (cached && isFresh(cached)) {
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

  const result = scanCustomTags(filePath, options);
  const entry = snapshot(result);
  const loadedSignature = loadedSignatureOf(entry);
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

/** Drops every cached scan. For tests and for an editor's "restart" command. */
export function clearScanCache(): void {
  scans.clear();
  maps.clear();
  liveSignature = undefined;
}

/** Copies of file evidence only, for testing snapshot retention (not public API). */
export function scanCacheStampsForTests(): object[] {
  return [...scans.values()].flatMap((entry) =>
    [...entry.files.values(), ...entry.manifests.values()].map((stamp) => ({
      ...stamp,
    })),
  );
}

/** How many distinct tag-set maps are live. A test asserts this stays bounded. */
export function liveTagMapCount(): number {
  return maps.size;
}
