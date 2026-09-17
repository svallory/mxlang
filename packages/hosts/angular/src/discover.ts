/**
 * Resolves the set of `.mx` files a project's `mx-angular build` compiles,
 * and routes each one to a page or a tag output (design note A3, "Two
 * output kinds").
 */

import {
  existsSync,
  globSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  discoverProjectTags,
  hostModuleSegment,
  type MxTagsEntry,
  normalizeMxTags,
  TranslateError,
} from "@mxlang/core";
import type { AngularConfig } from "./config.ts";

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
  kind: "page" | "tag" | "ngmx";
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
  /**
   * Every `tags/` directory `discoverProjectTags` walked, plus every
   * `mx.tags` entry directory claimed for `"angular"` — including one that
   * is empty, or whose every name was shadowed by a shallower `tags/`
   * directory of the same name, or that holds only sidecar `.tag.ts` files
   * with no `.mx` template (none of which leave a `DiscoveredTag` behind, so
   * deriving this list from surviving tags alone would silently drop it). A
   * watcher needs the complete list to know which directories to watch even
   * when one currently yields nothing.
   */
  tagDirectories: string[];
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
 *
 * A matched file carrying a host-module segment core does not route to this
 * host (`.solid.mx`, or any future one besides `.ng`) is excluded from page
 * compilation with a positioned diagnostic — it is a different file kind,
 * not a page, and silently dropping it would leave an author wondering why
 * it never compiled. `diagnostics` is optional because the second caller
 * below (the `.ng.mx`-only glob) can never match a non-`ng` segment, so it
 * has nothing to report here.
 */
function expandInclude(
  projectDir: string,
  realProjectDir: string,
  include: string[],
  diagnostics?: DiscoverDiagnostic[],
): Set<string> {
  const matched = new Set<string>();
  for (const pattern of include) {
    for (const file of globSync(pattern, {
      cwd: projectDir,
      exclude: ["**/node_modules/**"],
    })) {
      if (!file.endsWith(".mx")) continue;
      const segment = hostModuleSegment(basename(file));
      if (segment !== undefined && segment !== "ng") {
        const resolved = resolve(projectDir, file);
        diagnostics?.push({
          file: resolved,
          message: `\`${basename(file)}\` is a host module file, not a tag template; tag templates are \`.mx\``,
        });
        continue;
      }
      const resolved = resolve(projectDir, file);
      if (isInside(realProjectDir, realResolve(resolved)))
        matched.add(resolved);
    }
  }
  return matched;
}

/**
 * `mx.tags` entries declaring `hosts` that exclude `"angular"` — read
 * directly from `projectDir`'s own `package.json`, the only manifest
 * `discoverProjectTags` itself consults (core's project boundary means a
 * nested package's `mx.tags` is out of scope entirely, see the module
 * doc). `ScanResult.directories` carries every `mx.tags` entry's directory
 * unconditionally (`indexMxTagsEntries` pushes it before applying `hosts`),
 * so this host must re-derive the exclusion itself to keep a
 * different-host-only tag directory out of the watched set, the same as
 * `ScanResult.tags`/`customTags` already do for the compiled tag map.
 */
function excludedMxTagsDirs(projectDir: string): Set<string> {
  const packageJson = join(projectDir, "package.json");
  if (!existsSync(packageJson)) return new Set();
  let manifest: { mx?: { tags?: unknown } } | undefined;
  try {
    manifest = JSON.parse(readFileSync(packageJson, "utf8"));
  } catch {
    // Silent, not swallowed: discoverProjectTags reads this same
    // package.json through readManifest and already pushes a
    // ScanResult.diagnostics entry naming it on a parse failure — pushing
    // one here too would double-warn for one broken file.
    return new Set();
  }
  let entries: MxTagsEntry[];
  try {
    entries = normalizeMxTags(manifest?.mx?.tags, projectDir, packageJson);
  } catch {
    // Same reasoning: discoverProjectTags's own indexMxTagsEntries calls
    // normalizeMxTags against this manifest and reports an invalid
    // `mx.tags` shape (e.g. a bad `hosts` entry) as a TranslateError caught
    // and diagnosed upstream of this function ever running.
    return new Set();
  }
  const excluded = new Set<string>();
  for (const entry of entries) {
    if (entry.hosts && !entry.hosts.includes("angular")) {
      excluded.add(resolve(entry.dir));
    }
  }
  return excluded;
}

/**
 * Whether `err` is core's `rejectHostModuleFile` rejection (`.ng.mx`/
 * `.solid.mx` under `tags/`), as opposed to any other `TranslateError`
 * `discoverProjectTags` can raise (an invalid `mx.tags` shape, a bad tag
 * filename). There is no non-throwing variant of that check to call instead,
 * so this narrows by the message core owns rather than catching every
 * `TranslateError` as though it were this one case. Returns the rejected
 * file's path (`failIn` bakes `${file}: ${message}` into `err.message`,
 * since `TranslateError.file` is only set for a foreign-file position),
 * or `undefined` if this is not that rejection at all.
 */
function hostModuleFileErrorPath(err: TranslateError): string | undefined {
  const match = /^(.*): `[^`]+` is a host module file, not a tag template/.exec(
    err.message,
  );
  return match?.[1];
}

/**
 * Every `.mx` tag file discovered under `projectDir`, via `@mxlang/core`'s
 * project-wide enumerator (`discoverProjectTags`, the `"angular"` host
 * filter already excluding any `mx.tags` entry that scopes itself to other
 * hosts from `tags`/`customTags`). A discovered template or `tags/`
 * directory outside `projectDir` (a followed `mx.tags` entry with an
 * absolute or `../`-escaping `dir`, or a `tags/` directory symlink pointing
 * outside the project — `discoverProjectTags`'s walk follows directory
 * symlinks) is dropped for the same reason `expandInclude` drops one.
 */
function discoverTagFiles(
  projectDir: string,
  realProjectDir: string,
  diagnostics: DiscoverDiagnostic[],
): { templates: Set<string>; tagDirectories: string[]; rejected: Set<string> } {
  let result: ReturnType<typeof discoverProjectTags>;
  try {
    result = discoverProjectTags(projectDir, { host: "angular" });
  } catch (err) {
    // A host module file (`.ng.mx`, `.solid.mx`) under a `tags/` directory:
    // core's own `rejectHostModuleFile` throws a positioned `TranslateError`
    // naming the file — reported here as a diagnostic rather than left to
    // escape as an uncaught exception, since it is not a tag template. Any
    // other `TranslateError` from this scan (an invalid `mx.tags` shape, a
    // broken tag file) stays fatal, matching `readAngularConfig`'s own
    // fatal-on-bad-config contract: only this one rejection is a "different
    // file kind, not a configuration mistake" case worth downgrading.
    const rejectedPath =
      err instanceof TranslateError ? hostModuleFileErrorPath(err) : undefined;
    if (err instanceof TranslateError && rejectedPath !== undefined) {
      diagnostics.push({ file: projectDir, message: err.message });
      // The whole project-wide scan aborted on this one file, so nothing
      // discovered elsewhere in the tree is known — but the rejected path
      // itself must still be kept out of the page/`.ng.mx` routing below, or
      // a `.ng.mx` under `tags/` would still be compiled as a component
      // module even though it was just rejected as "not a tag".
      return {
        templates: new Set(),
        tagDirectories: [],
        rejected: new Set([resolve(rejectedPath)]),
      };
    }
    throw err;
  }
  for (const d of result.diagnostics) {
    diagnostics.push({ file: d.file, message: d.message });
  }

  const templates = new Set<string>();
  for (const tag of result.tags.values()) {
    if (!tag.template) continue;
    const resolved = resolve(tag.template);
    if (isInside(realProjectDir, realResolve(resolved))) {
      templates.add(resolved);
    }
  }

  // Every tags/ directory core walked, not just the ones a surviving tag's
  // sourceDir points at: an empty tags/ dir, or one whose every name was
  // shadowed by a shallower tags/ dir of the same name, leaves no
  // DiscoveredTag behind but must still be watched.
  const excludedDirs = excludedMxTagsDirs(projectDir);
  const tagDirectories = new Set<string>();
  for (const dir of result.directories) {
    const resolvedDir = resolve(dir);
    if (excludedDirs.has(resolvedDir)) continue;
    if (!isInside(realProjectDir, realResolve(resolvedDir))) continue;
    tagDirectories.add(resolvedDir);

    // core's own indexDirectory swallows a readdir failure silently (a
    // missing mx.tags-named directory is diagnosed separately, above, but
    // an existing, unreadable one — EACCES — is not); probe it once here so
    // an author learns why a subtree yielded nothing, rather than the
    // silent "found zero tags" the old per-directory walk also used to
    // report through a diagnostic.
    if (!existsSync(resolvedDir)) continue;
    try {
      readdirSync(resolvedDir);
    } catch (err) {
      diagnostics.push({
        file: resolvedDir,
        message: `could not read directory: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    templates,
    tagDirectories: [...tagDirectories],
    rejected: new Set<string>(),
  };
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
  const included = expandInclude(
    projectDir,
    realProjectDir,
    config.include,
    diagnostics,
  );
  const {
    templates: tagFiles,
    tagDirectories,
    rejected,
  } = discoverTagFiles(projectDir, realProjectDir, diagnostics);
  // Discovered project-wide rather than through `include`, exactly as the
  // tag index is. A `.ng.mx` emits the component module Angular compiles, so
  // a narrowed `include` (`src/pages/**/*.mx`, say) silently skipping one
  // would leave a component that never builds and no diagnostic saying why.
  // Its own extension makes it unambiguous, so there is nothing to configure.
  const ngMxFiles = expandInclude(projectDir, realProjectDir, ["**/*.ng.mx"]);

  const overlapWarnings: string[] = [];
  const files: RoutedFile[] = [];
  const seen = new Set<string>(rejected);

  for (const path of included) {
    if (seen.has(path)) continue;
    seen.add(path);
    // `.ng.mx` is its own file kind, not a page: it emits a whole TypeScript
    // module rather than a bare template, so it must never take the page
    // route — which would write a `.html` beside it and drop the module.
    if (hostModuleSegment(basename(path)) === "ng") {
      files.push({ path, kind: "ngmx" });
      continue;
    }
    const isTag = tagFiles.has(path);
    if (isTag) overlapWarnings.push(path);
    files.push({ path, kind: isTag ? "tag" : "page" });
  }

  for (const path of tagFiles) {
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, kind: "tag" });
  }

  for (const path of ngMxFiles) {
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, kind: "ngmx" });
  }

  return { files, overlapWarnings, diagnostics, tagDirectories };
}
