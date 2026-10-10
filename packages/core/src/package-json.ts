/**
 * `package.json` reads shared by every walk in this package that asks a
 * question of the nearest manifest: `scan.ts` (`mx.tags`) and `host-policy.ts`
 * (`mx.host`, host dependencies).
 *
 * Two walks reading the same file twice, and disagreeing about what a broken
 * one means, is how a project ended up with its tags read from one
 * `package.json` and its host from another. They now read through here: one
 * parse per revision (keyed by a stat stamp), one answer for what a parse failure
 * looks like.
 *
 * A parse failure keeps the *previous* good manifest on the result (an editor
 * mid-save is not a reason to make every open file's tags disappear) and
 * reports the failure alongside it. A caller that has no use for a stale
 * manifest (`host-policy.ts`) ignores `manifest` when `error` is set.
 */

import { readFileSync, statSync } from "node:fs";

/** Why a `package.json` revision could not be parsed, positioned in it. */
export interface PackageJsonParseError {
  message: string;
  /** 1-based. `1` when the parser's message carries no position. */
  line: number;
  /** 0-based. `0` when the parser's message carries no position. */
  column: number;
}

export interface PackageJsonRead {
  /**
   * The parsed contents as JSON.parse returned them (not validated to be an
   * object). When `error` is set: the last good revision's contents, or
   * `undefined` if this path never parsed.
   */
  manifest: unknown;
  /** This revision's text, `""` if it could not be read. Offsets index into it. */
  text: string;
  error?: PackageJsonParseError;
}

interface CacheEntry extends PackageJsonRead {
  /** See `stampOf`: what the file looked like when this entry was read. */
  stamp: string;
}

/**
 * The fields of a `stat` result the revision stamp reads. Structural, so the
 * emitted declarations name no `node:fs` type.
 */
export interface PackageJsonStat {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

const cache = new Map<string, CacheEntry>();

let statFile: (path: string) => PackageJsonStat = statSync;

/** For tests: replaces the `stat` the cache keys on (coarse-timestamp filesystems); no argument restores it. */
export function setPackageJsonStatForTests(
  stat?: (path: string) => PackageJsonStat,
): void {
  statFile = stat ?? statSync;
}

/** For tests: drops every cached `package.json` read. */
export function clearPackageJsonCache(): void {
  cache.clear();
}

/**
 * Converts a character offset in `text` to a 1-based line and 0-based column.
 */
export function positionOfOffset(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart };
}

/**
 * The position of the key at `path` in a JSON text (`["mx", "contracts"]`,
 * `["mx", "dialect", "id"]`): the key itself, not a string or a nested decoy
 * with the same name. `1:0` when it is not there. The text need not parse:
 * the walk reads tokens, so a broken revision still positions what it can.
 */
export function jsonKeyPosition(
  text: string,
  path: readonly string[],
): { line: number; column: number } {
  const tokens = [
    ...text.matchAll(
      /"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    ),
  ];
  const target = path.join("\0");
  let cursor = 0;
  let offset = 0;
  const value = (at: string[]): void => {
    const start = tokens[cursor++];
    if (!start) return;
    if (start[0] === "{") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "}") {
        const key = tokens[cursor++];
        if (!key) return;
        let name: string;
        try {
          name = JSON.parse(key[0]) as string;
        } catch {
          return;
        }
        const keyPath = [...at, name];
        if (offset === 0 && keyPath.join("\0") === target) offset = key.index;
        cursor++; // colon
        value(keyPath);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    } else if (start[0] === "[") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "]") {
        value([...at, "[]"]);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    }
  };
  value([]);
  return positionOfOffset(text, offset);
}

/**
 * Where a parse failure is, from whatever the runtime's message says.
 *
 * `JSON.parse` messages differ by engine: V8 writes `… at position 12 (line 3
 * column 1)`, older V8 `… at position 12`, JavaScriptCore (Bun) writes no
 * position at all. So position is best-effort and `1:0` is the honest answer
 * when there is none; nothing may depend on it being present.
 */
export function positionOfParseError(
  message: string,
  text: string,
): { line: number; column: number } {
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn) {
    return {
      line: Number(lineColumn[1]),
      column: Math.max(0, Number(lineColumn[2]) - 1),
    };
  }
  const offset = /position (\d+)/.exec(message);
  if (offset) return positionOfOffset(text, Number(offset[1]));
  return { line: 1, column: 0 };
}

/**
 * What makes one revision of a file differ from the last, from one `stat`.
 *
 * `mtimeMs` alone misses an edit that restores or pins the mtime (`touch -r`,
 * `utimes`, some sync tools, a same-tick rewrite). `ctime` moves on every
 * write and cannot be set by the user, `size` catches most of the rest, and
 * `ino` catches an atomic replace (write-temp-then-rename, which editors and
 * package managers use).
 *
 * The stamp is only a fast filter, never proof of "unchanged": Linux before
 * 6.13 stamps ctime at jiffy granularity (4 ms at HZ=250), so a same-size
 * rewrite in the same tick can leave all four fields identical.
 * `readPackageJsonCached` therefore confirms a stamp hit against the bytes.
 */
function stampOf(stats: PackageJsonStat): string {
  return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`;
}

/** Whether `path` still reads as `entry.text`; an unreadable file is not "same". */
function sameText(path: string, entry: CacheEntry): boolean {
  try {
    return readFileSync(path, "utf8") === entry.text;
  } catch {
    return false;
  }
}

/**
 * Reads and parses `path`, reusing the last parse while its stamp
 * (mtime, ctime, size, inode) is unchanged *and* the file's text still equals
 * the cached text (a stamp hit costs one read plus a string compare, since the
 * stamp cannot see a same-tick same-size rewrite on coarse-ctime kernels). `undefined` means there is no such file (nothing is cached for
 * it); a file that exists but cannot be read or parsed returns an `error`.
 */
export function readPackageJsonCached(
  path: string,
): PackageJsonRead | undefined {
  let stamp: string;
  try {
    stamp = stampOf(statFile(path));
  } catch {
    cache.delete(path);
    return undefined;
  }

  const cached = cache.get(path);
  if (cached && cached.stamp === stamp && sameText(path, cached)) return cached;

  let text = "";
  let parsed: unknown;
  let failure: unknown;
  try {
    text = readFileSync(path, "utf8");
    parsed = JSON.parse(text);
  } catch (cause) {
    failure = cause;
  }

  if (failure === undefined) {
    const entry: CacheEntry = { stamp, manifest: parsed, text };
    cache.set(path, entry);
    return entry;
  }

  const message = (failure as Error).message;
  const entry: CacheEntry = {
    stamp,
    // Keep-last: a broken revision does not erase what a good one established.
    manifest: cached?.manifest,
    text,
    error: { message, ...positionOfParseError(message, text) },
  };
  cache.set(path, entry);
  return entry;
}
