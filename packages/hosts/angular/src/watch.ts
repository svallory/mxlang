/**
 * `mx-angular watch` (design note A3): incremental rebuild loop reusing
 * task 1.5a's per-file compile path (`compileOne`, `build.ts`). Watches
 * `include` plus every discovered `tags/` directory plus the project root
 * (for `package.json`); a page change recompiles that page only, a tag
 * template/sidecar change recompiles the tag's dependents, and a
 * config-relevant change (`package.json`, a new/deleted/moved `.mx` file,
 * or a new directory appearing) triggers a full rebuild.
 */

import {
  existsSync,
  type FSWatcher,
  watch as fsWatch,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { scanCached } from "@mxlang/core";
import {
  compileOne,
  outputPathFor,
  type PositionedMessage,
  removeOutputsFor,
} from "./build.ts";
import { type AngularConfig, readAngularConfig } from "./config.ts";
import { discoverFiles, isInside, type RoutedFile } from "./discover.ts";

export interface WatchHandle {
  /** Stops every underlying watcher and pending timer. Idempotent. */
  close(): void;
  /**
   * Resolves after the watcher has finished processing every currently
   * pending change (the initial build, plus any debounced rebuild already
   * in flight). Re-await after triggering a change of your own — each call
   * captures the state at call time, not a one-shot signal.
   */
  onIdle: Promise<void>;
}

export interface WatchOptions {
  /** Runs the initial build and resolves `onIdle` without starting any watchers. */
  once?: boolean;
  /** Debounce window in ms between a filesystem event and the rebuild it triggers. Default 50 (A3). */
  debounceMs?: number;
  /** Called once per write/skip/error line, in the exact text `mx-angular watch`'s terminal output uses. */
  onLine?: (line: string) => void;
}

const DEBOUNCE_MS_DEFAULT = 50;

function formatMessage(
  kind: "warning" | "error",
  m: PositionedMessage,
): string {
  const position = m.line !== undefined ? `:${m.line}:${m.column}` : "";
  return `${m.file}${position} ${kind}: ${m.message}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Starts the watcher: an initial full rebuild, then incremental recompiles
 * on every subsequent change. Returns a handle whose `close()` stops every
 * underlying `fs.watch` and pending timer, and whose `onIdle` resolves once
 * the currently pending work has settled.
 */
export function startWatch(
  projectDir: string,
  options: WatchOptions = {},
): WatchHandle {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS_DEFAULT;
  const onLine = options.onLine ?? (() => {});
  const resolvedProjectDir = resolve(projectDir);

  // Every output path this watcher itself has written (round 1 R-b): an
  // fs.watch event whose path is in here is this tool's own write, not a
  // user edit, and must never re-trigger a rebuild — otherwise writing
  // page.html retriggers watching its own directory, which recompiles
  // (identical bytes, no-op) but still touches the .map sidecar's mtime,
  // which retriggers again, forever.
  const knownOutputs = new Set<string>();

  // page path -> tag mx/ts paths it depends on (resolved from usedTags
  // names against that page's own discovered tag index, plus a text-scan
  // fallback for a macro sidecar with no Component node — see recordDeps).
  const dependents = new Map<string, Set<string>>();

  // The previously routed set, keyed by resolved path (round 1 R-d: needed
  // to detect a vanished .mx file and apply onError to its orphaned output).
  let previousRouted = new Map<string, RoutedFile>();

  let watchers: FSWatcher[] = [];
  let watchedDirs = new Set<string>();
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPaths = new Set<string>();
  let closed = false;

  // The last config that read cleanly, kept across a transiently-invalid
  // package.json (round 2 finding 1): readAngularConfig() throws a
  // TranslateError on malformed JSON or an unrecognized key, and mid-edit a
  // save can easily pass through such a state for one keystroke. Thrown
  // from inside a bare setTimeout callback (fullRebuild()/processPending(),
  // both invoked only from timers, never awaited by a caller), an uncaught
  // throw there crashes the whole process instead of just failing one
  // rebuild.
  let lastGoodConfig: AngularConfig | undefined;

  function readConfigOrKeepLast(): AngularConfig | undefined {
    try {
      const config = readAngularConfig(projectDir);
      lastGoodConfig = config;
      return config;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLine(`${join(projectDir, "package.json")}:1:0 error: ${message}`);
      return lastGoodConfig;
    }
  }

  // A single "is a rebuild in flight right now" flag (round 1 R-e: was a
  // boolean already, kept as one, but must be the *only* signal onIdle
  // consults, and every timer this module starts is torn down by close()).
  let processing = false;

  function isQuiet(): boolean {
    return !processing && pendingTimer === undefined && pendingPaths.size === 0;
  }

  function waitForNextSettle(): Promise<void> {
    if (closed) return Promise.resolve();
    const pollMs = Math.max(5, Math.floor(debounceMs / 2));
    // How long nothing may be pending before concluding the watcher is
    // truly idle, not merely in the gap before `fs.watch` has delivered an
    // event for a change that just happened (there is no synchronous
    // signal that a change is even coming, so a single check would race).
    const requiredQuietMs = Math.max(100, debounceMs * 4);
    return new Promise((res) => {
      let quietSince: number | undefined;
      const poll = () => {
        if (closed) {
          res();
          return;
        }
        if (isQuiet()) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= requiredQuietMs) {
            res();
            return;
          }
        } else {
          quietSince = undefined;
        }
        pollTimer = setTimeout(poll, pollMs);
      };
      pollTimer = setTimeout(poll, pollMs);
    });
  }

  /**
   * Every tag name that appears as an XML-like tag (`<name`) in `source`,
   * restricted to `scan`'s own discovered names — the text-scan heuristic
   * `recordDeps` uses on a page's own source, factored out so it can also
   * walk each tag *template*'s own source for the transitive closure
   * (round 2 finding 3).
   */
  function scannedTagNames(
    source: string,
    scan: ReturnType<typeof scanCached>,
  ): string[] {
    const names: string[] = [];
    for (const name of scan.tags.keys()) {
      if (new RegExp(`<${escapeRegExp(name)}[/\\s>]`).test(source))
        names.push(name);
    }
    return names;
  }

  /**
   * Records which tag files `pagePath` depends on, transitively (round 2
   * finding 3: `home` calling `outer` calling `inner` must rebuild `home`
   * when `inner` changes, not just when `outer` does). Direct deps come
   * from `usedTagNames` (the IR's own record of a tag call that survived to
   * a `Component` node) plus a text-scan fallback over the page's own
   * source — needed because a sidecar `transform` may return IR directly as
   * a macro, fully inlined with no `Component` node and therefore no
   * `usedTags` entry, even though the compiled output genuinely depends on
   * that sidecar's current body. From each direct tag *template* (a `.mx`
   * file — a sidecar `.tag.ts` has no further MX source of its own to
   * scan), the same text-scan walks its own body for tags it calls, and so
   * on, cycle-safe via `visited`. Deliberately an over-approximation at
   * every level (a spurious rebuild is harmless; a missed one silently
   * serves stale output).
   */
  function recordDeps(pagePath: string, usedTagNames: string[]): void {
    const scan = scanCached(pagePath);
    const tagPaths = new Set<string>();
    const visited = new Set<string>();

    const addTag = (name: string) => {
      const tag = scan.tags.get(name);
      if (tag?.template) tagPaths.add(resolve(tag.template));
      if (tag?.sidecar) tagPaths.add(resolve(tag.sidecar));
      return tag;
    };

    const directNames = new Set(usedTagNames);
    for (const name of scannedTagNames(readFileSync(pagePath, "utf8"), scan)) {
      directNames.add(name);
    }

    const queue = [...directNames];
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (visited.has(name)) continue;
      visited.add(name);
      const tag = addTag(name);
      if (!tag?.template) continue; // a sidecar has no further MX body to scan.
      if (visited.has(tag.template)) continue; // cycle guard on the file itself too.
      visited.add(tag.template);
      let tagSource: string;
      try {
        tagSource = readFileSync(tag.template, "utf8");
      } catch {
        continue;
      }
      for (const nested of scannedTagNames(tagSource, scan)) {
        if (!visited.has(nested)) queue.push(nested);
      }
    }

    if (tagPaths.size === 0) dependents.delete(pagePath);
    else dependents.set(pagePath, tagPaths);
  }

  function pagesDependingOn(tagPath: string): string[] {
    const result: string[] = [];
    for (const [page, tagPaths] of dependents) {
      if (tagPaths.has(tagPath)) result.push(page);
    }
    return result;
  }

  function rebuildOne(routed: RoutedFile, config: AngularConfig): void {
    const result = compileOne(routed, config, knownOutputs);
    for (const line of result.lines) onLine(line);
    recordDeps(routed.path, result.usedTags);
  }

  /** Every directory under `root`, `root` included, skipping `node_modules` and any dot-prefixed *directory* (`.git`, `.turbo`, etc — dotfiles that aren't directories are never visited by this walk in the first place, since it only ever descends into entries `statSync` reports as a directory) — needed because a brand-new empty subdirectory (round 1 R-c: `mkdir -p src/deep/nested`) holds no routed file yet and so can't be found through `files`/`tagDirectories`, but a `.mx` written into it right after must still be observed. */
  function walkAllDirs(root: string): Set<string> {
    const dirs = new Set<string>([root]);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return dirs;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(root, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const d of walkAllDirs(full)) dirs.add(d);
    }
    return dirs;
  }

  /** Every directory `fs.watch` should cover: every directory under the project root, plus every discovered `tags/` directory (which may live outside the project root via `mx.tags`). */
  function computeWatchedDirs(tagDirectories: string[]): Set<string> {
    const dirs = walkAllDirs(resolvedProjectDir);
    for (const dir of tagDirectories) dirs.add(dir);
    return dirs;
  }

  function fullRebuild(): void {
    const config = readConfigOrKeepLast();
    if (!config) return; // package.json has never read cleanly; nothing to rebuild yet.
    const { files, overlapWarnings, diagnostics, tagDirectories } =
      discoverFiles(projectDir, config);
    for (const path of overlapWarnings) {
      onLine(
        formatMessage("warning", {
          file: path,
          line: 1,
          column: 0,
          message:
            "matched by both `include` and the tag index; the tag-index route wins",
        }),
      );
    }
    for (const d of diagnostics) {
      onLine(formatMessage("warning", { file: d.file, message: d.message }));
    }

    const nextRouted = new Map<string, RoutedFile>();
    for (const f of files) nextRouted.set(f.path, f);

    // A source that vanished since the last routed set (round 1 R-d): apply
    // onError to its now-orphaned output.
    //
    // Every kind, not only pages. A deleted `.ng.mx` or tag left its emitted
    // `.ts` on disk, which Angular goes on compiling — a component that
    // still exists as far as the build is concerned, with no source left to
    // explain it.
    for (const [path, routed] of previousRouted) {
      if (nextRouted.has(path)) continue;
      if (config.onError === "delete") {
        const { line } = removeOutputsFor(
          path,
          config,
          knownOutputs,
          routed.kind,
        );
        onLine(line);
      } else {
        const extension =
          routed.kind === "ngmx"
            ? config.ngExtension
            : routed.kind === "tag"
              ? config.tagExtension
              : config.pageExtension;
        const outputPath = outputPathFor(path, extension);
        onLine(
          `${outputPath} warning: output for ${path} is orphaned (source removed; onError=${config.onError} leaves it in place)`,
        );
      }
      dependents.delete(path);
    }
    previousRouted = nextRouted;

    dependents.clear();
    for (const f of files) {
      if (f.kind === "tag") {
        const result = compileOne(f, config, knownOutputs);
        for (const line of result.lines) onLine(line);
        continue;
      }
      rebuildOne(f, config);
    }

    watchedDirs = computeWatchedDirs(tagDirectories);
    setupWatchers();
  }

  function processPending(): void {
    processing = true;
    try {
      const paths = [...pendingPaths];
      pendingPaths = new Set();
      pendingTimer = undefined;

      // Ignore this watcher's own writes (round 1 R-b).
      const relevant = paths.filter((p) => !knownOutputs.has(p));
      if (relevant.length === 0) return;

      const config = readConfigOrKeepLast();
      if (!config) return; // package.json is invalid; reported, previous state left alone.
      const routedByPath = previousRouted;

      const knownTagPaths = new Set<string>();
      for (const tagPaths of dependents.values()) {
        for (const tagPath of tagPaths) knownTagPaths.add(tagPath);
      }

      let needsFullRebuild = false;
      const pageChanges = new Set<string>();
      const tagChanges = new Set<string>();

      for (const p of relevant) {
        if (basename(p) === "package.json") {
          needsFullRebuild = true;
          continue;
        }
        // A directory event (a new subdirectory created, e.g. `mkdir -p
        // src/deep/nested`) or any path this pass doesn't otherwise
        // recognize forces rediscovery (round 1 R-c): a new directory may
        // hold a `.mx` file or a `tags/` directory that must be watched.
        let isDirectory = false;
        try {
          isDirectory = existsSync(p) && statSync(p).isDirectory();
        } catch {
          isDirectory = false;
        }
        if (isDirectory) {
          needsFullRebuild = true;
          continue;
        }
        // A deleted path — a known tag file included (round 2 finding 4:
        // checked before `knownTagPaths.has(p)` below, so deleting a tag
        // file forces a full rebuild — re-deriving the tag index and the
        // watched-directory set — rather than being treated as an ordinary
        // "tag changed, recompile dependents" event, which would leave a
        // stale tag-index entry and a now-pointless watcher on its
        // directory in place). routedByPath (the stale previousRouted map)
        // still has an entry for a deleted page too, so this must be
        // checked before that lookup as well, or the incremental "page
        // changed" branch tries to recompile a file that no longer exists.
        if (!existsSync(p)) {
          needsFullRebuild = true;
          continue;
        }
        if (knownTagPaths.has(p)) {
          // A known tag dependency's own file — a template .mx or a
          // sidecar .tag.ts alike — recompiles its dependents directly,
          // without forcing a full rebuild merely because a sidecar isn't
          // itself a routed .mx file.
          tagChanges.add(p);
          continue;
        }
        if (!p.endsWith(".mx")) {
          // A non-.mx change inside a watched directory that isn't a known
          // tag dependency (e.g. a new sidecar this pass hasn't recorded a
          // dependency on yet) can change routing — a full rebuild covers
          // it, matching A3's "config change -> full rebuild".
          needsFullRebuild = true;
          continue;
        }
        const routedFile = routedByPath.get(p);
        if (!routedFile) {
          // A new .mx file changes the include/tag-index set itself. A
          // full rebuild re-derives routing correctly rather than
          // guessing from the stale set computed above.
          needsFullRebuild = true;
          continue;
        }
        if (routedFile.kind === "tag") tagChanges.add(p);
        else pageChanges.add(p);
      }

      if (needsFullRebuild) {
        fullRebuild();
        return;
      }

      for (const p of pageChanges) {
        const routed = routedByPath.get(p);
        if (routed) rebuildOne(routed, config);
      }
      for (const p of tagChanges) {
        for (const page of pagesDependingOn(p)) {
          const routed = routedByPath.get(page);
          if (routed) rebuildOne(routed, config);
        }
      }
    } finally {
      processing = false;
    }
  }

  function schedule(path: string): void {
    if (closed) return;
    if (knownOutputs.has(path)) return;
    pendingPaths.add(path);
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(processPending, debounceMs);
  }

  function setupWatchers(): void {
    for (const w of watchers) w.close();
    watchers = [];
    if (closed || options.once) return;

    for (const dir of watchedDirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = fsWatch(dir, (_event, filename) => {
          if (!filename) return;
          const full = resolve(dir, filename.toString());
          if (!isInside(resolvedProjectDir, full)) return;
          schedule(full);
        });
        watchers.push(watcher);
      } catch (err) {
        onLine(
          `${dir} warning: could not watch directory: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  processing = true;
  fullRebuild();
  processing = false;

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      if (pollTimer) clearTimeout(pollTimer);
      for (const w of watchers) w.close();
      watchers = [];
    },
    get onIdle(): Promise<void> {
      return waitForNextSettle();
    },
  };
}
