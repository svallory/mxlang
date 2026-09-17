/**
 * Resolves the set of `.mx` files a project's `mx-angular build` compiles,
 * and routes each one to a page or a tag output (design note A3, "Two
 * output kinds").
 */

import {
  existsSync,
  globSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  type DiscoveredTag,
  type MxTagsEntry,
  normalizeMxTags,
  scanCached,
} from "@mxlang/core";
import type { AngularConfig } from "./config.ts";

/** `@mxlang/core`'s own fixed directory name for a package's tags (`scan.ts`'s `TAGS_DIR`). */
const TAGS_DIR = "tags";

export interface DiscoverDiagnostic {
  file: string;
  message: string;
}

/**
 * Whether `path` is `root` itself or a descendant of it. `mx-angular build`
 * both reads and *writes* beside whatever it discovers, so an `include`
 * pattern or a followed symlink that resolves outside the project directory
 * must never be treated as a project file — that would turn a config value
 * into a write-anywhere gadget.
 */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "." ||
    rel === "" ||
    (!rel.startsWith("..") && !rel.startsWith(`..${sep}`))
  );
}

/**
 * Resolves `path` to its real, symlink-free location, for a containment
 * check that a symlink cannot spoof. `resolve()` alone only normalizes a
 * path's text — a symlinked `tags/` directory *inside* `projectDir`
 * resolves (textually) to a path inside it even though the directory it
 * actually points to may be outside. Falls back to the plain resolved path
 * when the target doesn't exist (e.g. a stale symlink), since there is
 * nothing left on disk to canonicalize.
 */
function realResolve(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export interface RoutedFile {
  path: string;
  kind: "page" | "tag";
}

export interface DiscoverResult {
  files: RoutedFile[];
  /**
   * A path matched by both `include` and the tag index — warned once per
   * build (A3: "warns once when `include` and the tag index both claim a
   * path").
   */
  overlapWarnings: string[];
  diagnostics: DiscoverDiagnostic[];
}

/**
 * Expands `config.include` glob patterns, relative to `projectDir`. Only
 * `.mx` matches count — a glob like `src/**` would otherwise sweep up every
 * file type in the tree — and `node_modules` plus this config's own output
 * extensions are excluded so a build never treats its own generated output,
 * or a dependency's source, as something to compile. Any match that resolves
 * outside `projectDir` — a `../` pattern, or a symlink `globSync` followed
 * out of the tree — is dropped rather than compiled: this tool writes output
 * beside every file it compiles, so a path outside the project must never be
 * treated as one of its sources.
 */
function expandInclude(
  projectDir: string,
  realProjectDir: string,
  include: string[],
): Set<string> {
  const matched = new Set<string>();
  for (const pattern of include) {
    for (const file of globSync(pattern, {
      cwd: projectDir,
      exclude: ["**/node_modules/**"],
    })) {
      if (!file.endsWith(".mx") || file.endsWith(".solid.mx")) continue;
      const resolved = resolve(projectDir, file);
      if (isInside(realProjectDir, realResolve(resolved)))
        matched.add(resolved);
    }
  }
  return matched;
}

/** One `tags/` directory, plus the nearest package boundary above it — the directory whose own `mx.tags` (and `hosts` filter) governs it, matching core's upward-walk semantics (`scan.ts:706-727`): a file's tag index comes from the *nearest* `package.json` above it, not the project root. */
interface TagsDirEntry {
  dir: string;
  /** The nearest ancestor directory (inclusive) holding a `package.json`, or `undefined` if none exists above it within the walk. */
  packageBoundary: string | undefined;
}

/**
 * Finds every `tags/` directory under `dir`, plus every distinct package
 * boundary encountered (a directory holding a `package.json`). Always
 * recurses past a nested `package.json` — core's own scan never refuses to
 * look inside a subdirectory merely because it happens to be a separate
 * package; it just changes which `package.json`'s `mx.tags` governs
 * anything found there. `excludedMxTagsDirs` reads each `tagsDir`'s own
 * `packageBoundary` to decide which `mx.tags` entries apply. Symlinked
 * entries are neither followed nor descended into: a symlink loop would
 * otherwise recurse without bound, and a symlink pointing outside the
 * project would let a `tags/` directory smuggle in files (and later,
 * outputs) from outside `projectDir`.
 */
function walkForTagSources(
  dir: string,
  nearestPackageBoundary: string | undefined,
  diagnostics: DiscoverDiagnostic[],
): { tagsDirs: TagsDirEntry[]; packageBoundaries: string[] } {
  const tagsDirs: TagsDirEntry[] = [];
  const packageBoundaries: string[] = [];
  const ownBoundary = existsSync(join(dir, "package.json"))
    ? dir
    : nearestPackageBoundary;
  if (ownBoundary === dir) packageBoundaries.push(dir);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // ENOENT (deleted mid-walk) is an ordinary race, not worth reporting;
    // anything else (most notably EACCES) silently means "no tags found
    // here" with zero explanation, which is worse than a diagnostic line.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      diagnostics.push({
        file: dir,
        message: `could not read directory: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return { tagsDirs, packageBoundaries };
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(full);
    } catch {
      // A race (entry removed between readdir and lstat) — not worth a
      // diagnostic, since there is nothing left at `full` to point at.
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (entry === TAGS_DIR) {
      tagsDirs.push({ dir: full, packageBoundary: ownBoundary });
      continue;
    }
    const nested = walkForTagSources(full, ownBoundary, diagnostics);
    tagsDirs.push(...nested.tagsDirs);
    packageBoundaries.push(...nested.packageBoundaries);
  }
  return { tagsDirs, packageBoundaries };
}

/** `mx.tags` entries declaring `hosts` that exclude `"angular"` — not claimed by this host. */
function excludedMxTagsDirs(
  packageBoundaries: string[],
  diagnostics: DiscoverDiagnostic[],
): Set<string> {
  const excluded = new Set<string>();
  for (const packageDir of packageBoundaries) {
    const packageFile = join(packageDir, "package.json");
    let manifest: { mx?: { tags?: unknown } } | undefined;
    try {
      manifest = JSON.parse(readFileSync(packageFile, "utf8"));
    } catch (err) {
      diagnostics.push({
        file: packageFile,
        message: `could not read package.json: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    let entries: MxTagsEntry[];
    try {
      entries = normalizeMxTags(manifest?.mx?.tags, packageDir, packageFile);
    } catch (err) {
      diagnostics.push({
        file: packageFile,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const entry of entries) {
      if (entry.hosts && !entry.hosts.includes("angular")) {
        excluded.add(entry.dir);
      }
    }
  }
  return excluded;
}

/**
 * Every `.mx` tag file discovered under `projectDir`: every `tags/`
 * directory's contents (`@mxlang/core`'s scan, called once per directory
 * found, since the scan only walks *upward* from a file) plus
 * `package.json#mx.tags` entries (discovered from any file under the
 * project root), minus any `mx.tags` entry whose `hosts` excludes
 * `"angular"` — a tag scoped to other hosts is not claimed here. A
 * discovered template outside `projectDir` (a followed `mx.tags` entry with
 * an absolute or `../`-escaping `dir`) is dropped for the same reason
 * `expandInclude` drops one.
 */
function discoverTagFiles(
  projectDir: string,
  realProjectDir: string,
  diagnostics: DiscoverDiagnostic[],
): Set<string> {
  const { tagsDirs, packageBoundaries } = walkForTagSources(
    projectDir,
    undefined,
    diagnostics,
  );
  const excludedDirs = excludedMxTagsDirs(packageBoundaries, diagnostics);

  const templates = new Set<string>();
  const collect = (result: ReturnType<typeof scanCached>) => {
    for (const tag of result.tags.values() as IterableIterator<DiscoveredTag>) {
      if (!tag.template) continue;
      if (tag.sourceDir && excludedDirs.has(resolve(tag.sourceDir))) continue;
      const resolved = resolve(tag.template);
      if (isInside(realProjectDir, realResolve(resolved))) {
        templates.add(resolved);
      }
    }
  };

  // package.json#mx.tags and any tags/ directory an ancestor of the project
  // root would find — discovered from the project root itself.
  collect(scanCached(join(projectDir, "__mx_angular_probe__")));

  for (const tagsDir of tagsDirs) {
    collect(scanCached(join(tagsDir.dir, "__mx_angular_probe__")));
  }

  return templates;
}

/**
 * Builds the routed file list: `include` ∪ the tag index, each file marked
 * `page` or `tag` by tag-index membership (discovery, not naming
 * convention — A3).
 */
export function discoverFiles(
  projectDir: string,
  config: AngularConfig,
): DiscoverResult {
  const diagnostics: DiscoverDiagnostic[] = [];
  // Canonicalized once: on macOS the system temp dir itself is a symlink
  // (/var -> /private/var), so comparing a realpath'd leaf against an
  // un-realpath'd projectDir would report every file as "outside" even
  // with no symlink escape at all.
  const realProjectDir = realResolve(projectDir);
  const included = expandInclude(projectDir, realProjectDir, config.include);
  const tagFiles = discoverTagFiles(projectDir, realProjectDir, diagnostics);

  const overlapWarnings: string[] = [];
  const files: RoutedFile[] = [];
  const seen = new Set<string>();

  for (const path of included) {
    if (seen.has(path)) continue;
    seen.add(path);
    const isTag = tagFiles.has(path);
    if (isTag) overlapWarnings.push(path);
    files.push({ path, kind: isTag ? "tag" : "page" });
  }

  for (const path of tagFiles) {
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, kind: "tag" });
  }

  return { files, overlapWarnings, diagnostics };
}
