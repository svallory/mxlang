/**
 * Custom tag discovery (spec §4): MX owns the scan.
 *
 * From a calling file's directory upward to the package root (the nearest
 * `package.json`), every `tags/` directory found is indexed; a tag's name is
 * its filename's basename. `package.json#mx.tags` extends that walk with
 * explicitly named directories carrying directory-level defaults. The result
 * is the `customTags` map every host, loader, plugin and the language server
 * already accept (P1) — discovery is the only thing this module adds.
 * `mx.contracts` adds package-level declaration maps (decision 142), evaluated
 * eagerly on a cache miss to learn their names and parser options. Sidecars
 * retain the static/lazy loading behavior described below.
 *
 * Three properties shape the implementation, each load-bearing:
 *
 * 1. **Synchronous.** Every integration that needs the map calls into it from
 *    a synchronous position: Bun's `onLoad`, Volar's `createVirtualCode`, the
 *    language server's `diagnoseDocument`, `mx-tsc`'s program construction.
 *    Only the Vite plugin could await. One synchronous scan is therefore the
 *    only shape that serves all of them from a single implementation, which
 *    is what keeps an editor, a `tsc` run and a build from disagreeing about
 *    which tags a file can call.
 *
 * 2. **Indexed without execution.** A tag's `parseOptions` must reach Marko
 *    *before* the calling file is parsed, so the scan cannot wait for the
 *    sidecar's hooks to be usable. It reads `parseOptions` statically out of
 *    the sidecar's default export instead (see `readParseOptions`), and
 *    defers loading the module itself until a `transform` is actually needed.
 *
 * 3. **Lazily loaded, through the runtime's own loader.** The hooks arrive
 *    via a synchronous `require` of the `.tag.ts` file. Bun compiles
 *    TypeScript natively, and Node strips types on `require` of a `.ts` file
 *    (measured on Node 26 and Bun 1.3), so neither needs a transform step
 *    from MX. A sidecar that throws while loading surfaces as a positioned
 *    `TranslateError` naming the file, never as a crash — the language server
 *    depends on that.
 *
 * Reading the filesystem is the point of this module, so unlike the rest of
 * `@mxlang/core` it imports `node:fs`, as `host-policy.ts` already does for
 * the same reason.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { coreBabel } from "./babel.ts";
import {
  type ClaimedFields,
  claimedFields,
  claimedFieldsOf,
  dialectModuleOf,
} from "./contract-fields.ts";
import { isTranslateError, TranslateError } from "./core.ts";
import {
  type ContractMap,
  CUSTOM_TAG_KEYS,
  type CustomTag,
  type CustomTagParseOptions,
  type DeferredReader,
  deferContract,
  type LocateTagKey,
  markContractKeys,
  rejectUnknownDeclarationKeys,
  rejectUnknownTagKeys,
  rejectUnreachableHooks,
} from "./custom-tags.ts";
import { RESERVED_TAG_CODE } from "./diagnostic-codes.ts";
import {
  claimedExtensions,
  type DialectManifest,
  type DialectRoute,
  type DialectRouter,
  dialectRouter,
  routeDialect,
} from "./dialect-discovery.ts";
import { CORE_DIALECT } from "./dialect-registry.ts";
import {
  findMxConfig,
  mxConfigKeyPosition,
  mxConfigSearchPaths,
} from "./mx-config.ts";
import {
  clearPackageJsonCache,
  jsonKeyPosition,
  type PackageJsonParseError,
  readPackageJsonCached,
} from "./package-json.ts";
import { dropOwnParserPosition } from "./parse-error-position.ts";
import {
  dialectReservedMessage,
  RESERVED_NAMES,
  reservedNameMessage,
  TAG_NAME_RE,
} from "./tag-names.ts";
import type { TargetLookup } from "./target-descriptor.ts";
import type { TemplateTag } from "./template-tag.ts";

/**
 * The sha256 of the bytes the scan read from a tag file, keyed by that
 * file's `ScanResult.files` record (internal). The scan cache stamps a racy
 * file with this hash rather than one it reads later, so an edit between
 * the scan's read and the cache's snapshot, in the same timestamp tick,
 * reads as stale.
 */
const scannedHashes = new WeakMap<object, string>();

/** The hash of the bytes the scan read for `record`, when it read any. */
export function scannedHashOf(record: object): string | undefined {
  return scannedHashes.get(record);
}

/** Reads a tag file's text for the scan, recording its bytes' hash. */
function readScanned(path: string, record: object): string {
  const bytes = readFileSync(path);
  scannedHashes.set(record, createHash("sha256").update(bytes).digest("hex"));
  return bytes.toString("utf8");
}

const require = createRequire(import.meta.url);

/** The directory a tag file lives in, relative to its package. */
const TAGS_DIR = "tags";

/** A sidecar: the hooks half of a custom tag. */
const SIDECAR_SUFFIX = ".tag.ts";

/** A template tag (L1). Expansion itself is P3; discovery is here. */
const TEMPLATE_SUFFIX = ".mx";

/**
 * How one caller's files discover tags. Core's own discovery is a fixed
 * entry ({@link CORE_TAG_DISCOVERY}: core is dialect zero), a dialect's comes
 * from its manifest's `tagDirs`, `tagExtensions`, `sidecars`,
 * `reservedTags` and `mxConfigTags` ({@link tagDiscoveryOf}), and both go through one scan
 * (`indexDirectory`), which reads only this shape.
 */
export interface TagDiscovery {
  /** The dialect id (`mx` for core's own files). */
  readonly id: string;
  /** The dialect's name, as diagnostics write it. */
  readonly name: string;
  /** The directory names read at each level of the upward walk. */
  readonly tagDirs: readonly string[];
  /** The tag-file extensions: `.mx` for core, every claimed one for a dialect. */
  readonly extensions: readonly string[];
  /** Whether `<name>.tag.ts` sidecars index. */
  readonly sidecars: boolean;
  /** The names only this dialect may define (enforced by a later slice). */
  readonly reservedTags: readonly string[];
  /**
   * Whether the project's `package.json#mx.tags` and `mx.contracts` define
   * tags for these files (the manifest's `mxConfigTags`, default `true`).
   */
  readonly mxConfigTags: boolean;
  /**
   * `templates`: MX's own kinds, `.mx` templates (core, and a dialect that
   * declares no `tagDirs`, which scans exactly as MX does). `tag-files`:
   * files ending in one of `extensions` that route to this dialect, whose
   * contract the dialect reads.
   */
  readonly kind: "templates" | "tag-files";
}

/** Core's own tag discovery: `tags/`, `.mx` templates and `.tag.ts` sidecars. */
export const CORE_TAG_DISCOVERY: TagDiscovery = Object.freeze({
  id: CORE_DIALECT,
  name: "MX",
  tagDirs: Object.freeze([TAGS_DIR]),
  extensions: Object.freeze([TEMPLATE_SUFFIX]),
  sidecars: true,
  reservedTags: RESERVED_NAMES,
  mxConfigTags: true,
  kind: "templates" as const,
});

/** One discovery per manifest object, so a cache key and a scan agree. */
const discoveries = new WeakMap<DialectManifest, TagDiscovery>();

/**
 * The discovery a dialect's files use: its `tagDirs` with every extension it
 * claims, or, when it declares no `tagDirs`, MX's own (`tags/`, `.mx`
 * templates), so a dialect declaring none of the fields scans exactly as
 * MX's files do. `undefined` is MX's own files.
 */
export function tagDiscoveryOf(
  dialect: DialectManifest | undefined,
): TagDiscovery {
  if (dialect === undefined) return CORE_TAG_DISCOVERY;
  const known = discoveries.get(dialect);
  if (known) return known;
  const discovery: TagDiscovery = Object.freeze(
    dialect.tagDirs === undefined
      ? {
          ...CORE_TAG_DISCOVERY,
          id: dialect.id,
          name: dialect.name,
          sidecars: dialect.sidecars ?? true,
          reservedTags: dialect.reservedTags ?? [],
          mxConfigTags: dialect.mxConfigTags ?? true,
        }
      : {
          id: dialect.id,
          name: dialect.name,
          tagDirs: dialect.tagDirs,
          extensions: claimedExtensions(dialect),
          sidecars: dialect.sidecars ?? true,
          reservedTags: dialect.reservedTags ?? [],
          mxConfigTags: dialect.mxConfigTags ?? true,
          kind: "tag-files" as const,
        },
  );
  discoveries.set(dialect, discovery);
  return discovery;
}

/**
 * The discovery for `filePath`'s dialect. A file whose routing fails (a
 * clash, a broken `mx.extensions`) scans as MX's own: the compile reports
 * the routing error itself, and a scan is not where it is fixed.
 */
export function callerTagDiscovery(filePath: string): TagDiscovery {
  try {
    return tagDiscoveryOf(routeDialect(resolve(filePath)));
  } catch {
    return CORE_TAG_DISCOVERY;
  }
}

/**
 * The project routing of each directory a scan indexes, built once per
 * directory and only where some dialect declares `tagDirs` (with none, no
 * file name changes meaning). A routing error is not the scan's to report.
 */
type Routes = (dir: string) => DialectRouter | undefined;

function routesForScan(): Routes {
  const routers = new Map<string, DialectRouter | undefined>();
  return (dir) => {
    if (routers.has(dir)) return routers.get(dir);
    let router: DialectRouter | undefined;
    try {
      router = dialectRouter(dir);
    } catch {
      router = undefined;
    }
    routers.set(dir, router);
    return router;
  };
}

/** Where `entry` in `dir` routes, or `undefined`; a clash is not the scan's to report. */
function routeOf(
  routes: Routes,
  dir: string,
  entry: string,
): DialectRoute | undefined {
  try {
    return routes(dir)?.route(entry);
  } catch {
    return undefined;
  }
}

/**
 * A file-kind segment is known to a lookup when a registered target declares
 * a host module file kind with that segment: `.solid.mx` (the Solid host),
 * `.ng.mx` (the Angular host's per-region file kind) and `.astro.mx` (the
 * Astro host's template file kind, decision 134) for the built-in lookup.
 * The closed list core used to hold is gone (decision 126): the lookup
 * answers, and core holds no segment of any host's name.
 */

/**
 * The host segment a `.mx` file name carries — the `ng` in `card.ng.mx`, the
 * `solid` in `card.solid.mx` — or `undefined` when the name carries none the
 * lookup knows.
 *
 * `entry` is a file name (a basename), not a path. It returns `undefined`
 * for anything that is not a host module file: a name without the `.mx`
 * suffix, a plain `.mx` template (`card.mx`), and a dotted tag name whose
 * second segment is not a file-kind segment the lookup knows (`my.icon.mx`
 * is the ordinary tag `<my.icon>`).
 *
 * `targets` is required: which segments exist is an open-set question (a
 * third party registers its own file kinds), so a caller that forgot it gets
 * a type error rather than a silently closed-over list.
 *
 * Part of the documented host-authoring API of `@mxlang/core`. A host uses it
 * to route a host module file to its own module compiler (`=== "ng"` for the
 * Angular host) and to reject or exclude every other host's module file from
 * page and tag compilation with a positioned diagnostic, rather than
 * silently skipping it.
 */
export function hostModuleSegment(
  entry: string,
  targets: TargetLookup,
): string | undefined {
  if (!entry.endsWith(TEMPLATE_SUFFIX)) return undefined;
  const bare = entry.slice(0, -TEMPLATE_SUFFIX.length);
  const dot = bare.lastIndexOf(".");
  if (dot === -1) return undefined;
  const segment = bare.slice(dot + 1);
  return targets.moduleSegments().includes(segment) ? segment : undefined;
}

/**
 * Excludes `entry` from the tag map when its name cannot be called as a tag,
 * with a positioned diagnostic. Shared by `indexDirectory`, so
 * `scanCustomTags` and `discoverProjectTags` cannot drift on the rule.
 *
 * A `<base>.<word>.mx` file name under `tags/` is never a callable tag
 * (decision 137, design note §5.1 rule (d)): the concise syntax `x.ng` and
 * the tag form `<x.ng/>` both parse as tag `x` with shorthand class `ng`, so
 * no syntax can reach such an entry and indexing it would create a dead tag.
 * Two messages, both positional at the file:
 *
 * 1. `<word>` is a file-kind segment the lookup knows (`.ng.mx`, `.solid.mx`,
 *    `.astro.mx`): today's wording, unchanged — it is a host module file,
 *    not a tag template.
 * 2. Otherwise: the file is excluded with the reason it cannot be called, and
 *    what to do about it (another host's module file does not belong here;
 *    otherwise rename it without the dot).
 */
interface DottedTagFile {
  /** Position in the original diagnostic stream, independent of its wording. */
  diagnosticIndex: number;
  file: string;
  entry: string;
  segment: string;
  line: number;
  column: number;
}

/** Derive decision 137 wording from neutral filename evidence, per caller. */
export function dottedTagFileDiagnostics(
  files: readonly DottedTagFile[],
  targets: TargetLookup,
  diagnostics: readonly ScanDiagnostic[] = [],
): ScanDiagnostic[] {
  const result = [...diagnostics];
  for (const { file, entry, segment, line, column, diagnosticIndex } of files) {
    const bare = entry.slice(0, -TEMPLATE_SUFFIX.length);
    const first = bare.indexOf(".");
    const tag = bare.slice(0, first);
    const classes = bare.slice(first + 1).replaceAll(".", " ");
    result.splice(diagnosticIndex, 0, {
      file,
      line,
      column,
      message: targets.moduleSegments().includes(segment)
        ? `\`${entry}\` is a host module file, not a tag template; tag templates are \`.mx\``
        : `\`${entry}\` cannot be called as a tag: \`<${bare}>\` parses as tag \`${tag}\` with class \`${classes}\`. If it is another host's module file it does not belong under this host; otherwise rename it without the dot.`,
    });
  }
  return result;
}

function rejectUncallableTagFile(
  dir: string,
  entry: string,
  diagnostics: readonly ScanDiagnostic[],
  dottedTagFiles: DottedTagFile[],
): boolean {
  if (!entry.endsWith(TEMPLATE_SUFFIX)) return false;
  const bare = entry.slice(0, -TEMPLATE_SUFFIX.length);
  const dot = bare.lastIndexOf(".");
  if (dot === -1) return false;
  dottedTagFiles.push({
    diagnosticIndex: diagnostics.length + dottedTagFiles.length,
    file: join(dir, entry),
    entry,
    segment: bare.slice(dot + 1),
    line: 1,
    column: 0,
  });
  return true;
}

// `TAG_NAME_RE` (tag-names.ts) is what a tag file's name may be.

/**
 * A `package.json#mx.tags` entry, normalized.
 *
 * `dir` is resolved against the `package.json`'s own directory, so a config
 * is portable: it names a location in the package, not on one machine.
 */
export interface MxTagsEntry {
  dir: string;
  prefix?: string;
  hosts?: string[];
  parseOptions?: CustomTagParseOptions;
}

/** One discovered tag, before its sidecar is loaded. */
export interface DiscoveredTag {
  /** The call name: the file's basename, plus any configured prefix. */
  name: string;
  /** The `x.mx` template, when one exists. */
  template?: string;
  /** The `x.tag.ts` sidecar, when one exists. */
  sidecar?: string;
  /**
   * A dialect tag file (`concepts/money.mesh.mx`): a file in the
   * dialect's `tagDirs` ending in one of its claimed extensions, whose
   * contract the dialect reads. @unstable
   */
  tagFile?: string;
  /** The dialect whose tag file this is (`tagFile`'s dialect id). @unstable */
  dialect?: string;
  /** The package-level contracts module that supplied this entry. */
  module?: string;
  /** An eagerly loaded module declaration (sidecars remain lazy). */
  contract?: CustomTag;
  /**
   * `parseOptions` as the scan knows them before any hook runs: the
   * directory-level default from `mx.tags`, overridden by whatever the
   * sidecar's default export declares statically.
   */
  parseOptions?: CustomTagParseOptions;
  /** The directory this tag was found in; drives the nearest-wins rule. */
  sourceDir?: string;
  /**
   * Hosts this tag is visible to, from the `mx.tags` entry that declared it.
   * `undefined` means every host; a local `tags/` directory (no `mx.tags`
   * entry backing it) always carries `undefined` here, since only an
   * explicit `hosts` list narrows visibility.
   */
  hosts?: string[];
}

/** What one scan found, plus everything needed to know when it went stale. */
export interface ScanResult {
  /** Discovered tags by call name; nearest directory wins. */
  tags: Map<string, DiscoveredTag>;
  /**
   * The map to hand a compiler. Sidecar hooks load on first use; package-level
   * module declarations have already been evaluated during discovery.
   */
  customTags: Record<string, CustomTag>;
  /** Directories whose contents were read, for invalidation. */
  directories: string[];
  /** `package.json` files consulted, for invalidation. */
  packageFiles: string[];
  /**
   * Every MX config search place consulted (`mx.config.*`, `.mxrc*`, …),
   * most of which do not exist, for invalidation: creating, editing or
   * removing one changes the answer.
   */
  configFiles?: string[];
  /** Every tag file found, with the mtime it had when read. */
  files: Array<{ path: string; mtimeMs: number }>;
  /**
   * Configuration problems that do not stop discovery.
   *
   * An `mx.tags` entry naming a directory that is not there is a real mistake
   * an author wants told about, but it is not a reason to fail every file in
   * the package: the local `tags/` directories are still perfectly good, and
   * throwing here would make one typo in `package.json` break compilation of
   * files that never used that entry — with the language server landing the
   * error on whichever document happened to be open. Callers surface these
   * how they surface anything else; the scan itself carries on.
   */
  diagnostics: ScanDiagnostic[];
  /**
   * Every `mx.tags` entry's `hosts` value the scan read, in the order the
   * entries were indexed. Whether a name is a host anything can match is the
   * caller's lookup's answer, so the scan records rather than decides (see
   * `hostRestrictionDiagnostics`): a warning here would name no target it
   * knows, and a lookup that gains a host later would not get to tell the
   * author their `hosts` entry was fine all along.
   */
  hostRestrictions: HostRestriction[];
  /** Lookup-neutral evidence for decision 137 diagnostics (never cache wording). */
  dottedTagFiles?: DottedTagFile[];
}

/** One non-fatal configuration problem, positioned in the file that caused it. */
export interface ScanDiagnostic {
  /** The file to point an author at: the `package.json` that declared it. */
  file: string;
  message: string;
  line: number;
  column: number;
  /**
   * How bad it is, when the scan says: an `error` is a file the scan
   * skipped, a `warning` one it kept or ignored on purpose. Absent on the
   * scan's older diagnostics. @unstable
   */
  severity?: "error" | "warning";
  /** A stable code for the diagnostic (`MX_MISPLACED_TAG_FILE`), when it has one. @unstable */
  code?: string;
}

/**
 * The scan has no position to report against the *calling* file, since a
 * broken sidecar is a fact about the sidecar. Diagnostics therefore name the
 * offending file and carry that file's own position, which is what lets the
 * language server point an author at the real problem.
 */
/** Project-wide discovery has no one file, so no dialect claims keys. */
const NO_CLAIM = claimedFields(undefined);

/**
 * Runs `place`, which rethrows a registration error at its file, keeping the
 * `diagnosticCode` a dialect's `checkContract` gave it.
 */
function withCodeOf(cause: unknown, place: () => never): never {
  try {
    return place();
  } catch (placed) {
    const code = isTranslateError(cause) ? cause.diagnosticCode : undefined;
    if (code !== undefined && isTranslateError(placed)) {
      placed.diagnosticCode = code;
    }
    throw placed;
  }
}

function failIn(file: string, message: string, line = 1, column = 0): never {
  throw new TranslateError(message, line, column, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One `mx.tags` entry's `hosts` restriction: a value the entry named, with
 * the position in the `package.json` that declared it. The scan records
 * what it read and decides nothing about it — whether a name is a known host
 * is an open-set question the caller's lookup answers (see
 * {@link hostRestrictionDiagnostics}).
 */
export interface HostRestriction {
  /** The `package.json` that declared the `hosts` entry. */
  file: string;
  /** The `hosts` value, as written. */
  host: string;
  line: number;
  column: number;
  /** Absent on existing mx.tags evidence, for byte-identical warnings. */
  key?: "mx.contracts";
}

/**
 * Whether `value` is written like a package specifier rather than a bare
 * host name: it contains a `/` or starts with `@`, `.` or `/`. Such a value
 * names a host by package, which this project may not use; the scan stays
 * silent about it (design note §5, condition 5).
 */
function isPackageSpecifier(value: string): boolean {
  return value.includes("/") || /^[@./]/.test(value);
}

/**
 * The diagnostics a set of recorded `hosts` restrictions deserves under
 * `lookup` (decisions 129/132; design note §5). A value that is neither a
 * host value the lookup accepts nor shaped like a package specifier is a
 * bare unknown word and gets today's warning, byte-identical; a package
 * specifier is silent, since a project may name a host package it does not
 * depend on.
 *
 * Only a full registry may validate host names: an own-descriptor subset
 * cannot know whether a peer restriction is valid. Call sites with an
 * own-descriptor lookup do not call this helper; registry wrappers do.
 * Filtering and structural validation are independent of name validation.
 */
export function hostRestrictionDiagnostics(
  restrictions: readonly HostRestriction[],
  lookup: TargetLookup,
): ScanDiagnostic[] {
  const known = new Set(lookup.hostValues());
  const diagnostics: ScanDiagnostic[] = [];
  for (const restriction of restrictions) {
    if (known.has(restriction.host)) continue;
    if (isPackageSpecifier(restriction.host)) continue;
    const targetHost = lookup.hostOf(restriction.host);
    const hint = lookup.hasTarget(restriction.host)
      ? ` ("${restriction.host}" is a target; hosts filters by host${targetHost ? `: use "${targetHost}"` : "; this target has no host"})`
      : "";
    diagnostics.push({
      file: restriction.file,
      message: `\`${restriction.key ?? "mx.tags"}\` names an unknown host in \`hosts\`: ${restriction.host}${hint}`,
      line: restriction.line,
      column: restriction.column,
    });
  }
  return diagnostics;
}

/**
 * Validates and normalizes `package.json#mx.tags`.
 *
 * A string is shorthand for one directory with no defaults. Anything that is
 * neither a string nor an array of `{ dir, ... }` objects is a configuration
 * error naming the `package.json`, rather than a silently ignored key: a
 * misspelled config that discovers nothing looks exactly like a tag that does
 * not exist, which is the failure mode hardest to diagnose from a call site.
 */
export function normalizeMxTags(
  value: unknown,
  packageDir: string,
  packageFile: string,
): MxTagsEntry[] {
  if (value === undefined) return [];
  if (typeof value === "string") {
    return [{ dir: resolve(packageDir, value) }];
  }
  if (!Array.isArray(value)) {
    failIn(
      packageFile,
      "`mx.tags` must be a string or an array of { dir, prefix?, hosts?, parseOptions? }",
    );
  }

  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { dir: resolve(packageDir, entry) };
    }
    if (!isRecord(entry) || typeof entry.dir !== "string") {
      failIn(
        packageFile,
        `\`mx.tags[${index}]\` must be a string or an object with a \`dir\` string`,
      );
    }
    const normalized: MxTagsEntry = {
      dir: isAbsolute(entry.dir) ? entry.dir : resolve(packageDir, entry.dir),
    };
    if (entry.prefix !== undefined) {
      if (typeof entry.prefix !== "string") {
        failIn(packageFile, `\`mx.tags[${index}].prefix\` must be a string`);
      }
      normalized.prefix = entry.prefix;
    }
    if (entry.hosts !== undefined) {
      if (
        !Array.isArray(entry.hosts) ||
        entry.hosts.some((host) => typeof host !== "string")
      ) {
        failIn(
          packageFile,
          `\`mx.tags[${index}].hosts\` must be an array of strings`,
        );
      }
      normalized.hosts = entry.hosts as string[];
    }
    if (entry.parseOptions !== undefined) {
      normalized.parseOptions = checkParseOptions(
        entry.parseOptions,
        packageFile,
        `mx.tags[${index}].parseOptions`,
      );
    }
    return normalized;
  });
}

/** One normalized package-level contracts entry (decision 142). */
export interface MxContractsEntry {
  module: string;
  hosts?: string[];
}

/** Locate the direct mx.contracts key, not a string or nested decoy. */
function contractsPosition(packageFile: string): {
  line: number;
  column: number;
} {
  return mxKeyPosition(packageFile, "contracts");
}

/**
 * Locate the direct `mx.<key>` key of a `package.json` (`contracts`, `syntax`),
 * or the top-level `<key>` of another MX config file, not a string or nested
 * decoy; `1:0` when it is not found.
 */
export function mxKeyPosition(
  packageFile: string,
  mxKey: string,
  ...rest: string[]
): {
  line: number;
  column: number;
} {
  const path = [mxKey, ...rest];
  if (basename(packageFile) !== "package.json") {
    const { line, column } = mxConfigKeyPosition(packageFile, path);
    return { line, column };
  }
  return jsonKeyPosition(readPackageJsonCached(packageFile)?.text ?? "", [
    "mx",
    ...path,
  ]);
}

/**
 * Where the `index`th `mx.tags` entry is written, or the `tags` key when
 * `mx.tags` is a single string (no entry to point at) or the entry cannot be
 * found (a YAML or module config). Exact for JSON and `package.json`.
 */
function mxTagsEntryPosition(
  packageFile: string,
  index: number | undefined,
): { line: number; column: number } {
  const key = mxKeyPosition(packageFile, "tags");
  if (index === undefined) return key;
  const entry = mxKeyPosition(packageFile, "tags", `[${index}]`);
  const found = entry.line !== 1 || entry.column !== 0;
  return found ? entry : key;
}

/** Contracts failures address the actual source file, not the calling page. */
function failContracts(
  file: string,
  message: string,
  line = 1,
  column = 0,
): never {
  const prefix = `${file}: `;
  throw new TranslateError(
    message.startsWith(prefix) ? message.slice(prefix.length) : message,
    line,
    column,
    file,
  );
}

/** Validate configuration and resolve modules against the consuming package. */
export function normalizeMxContracts(
  value: unknown,
  packageDir: string,
  packageFile: string,
): MxContractsEntry[] {
  if (value === undefined) return [];
  const { line, column } = contractsPosition(packageFile);
  const reject = (message: string): never =>
    failContracts(packageFile, message, line, column);
  return (Array.isArray(value) ? value : [value]).map((entry, index) => {
    const what = `mx.contracts[${index}]`;
    if (typeof entry === "string") entry = { module: entry };
    if (!isRecord(entry))
      reject(
        `\`${what}\` must be a string or an object with a \`module\` string`,
      );
    // The assertion follows the throwing guard above (TypeScript cannot narrow
    // through a local never-returning callback).
    const config = entry as Record<string, unknown>;
    if (typeof config.module !== "string")
      reject(`\`${what}.module\` must be a string`);
    for (const key of Object.keys(config)) {
      if (key !== "module" && key !== "hosts")
        reject(
          `\`${what}.${key}\` is not supported; expected \`module\` or \`hosts\``,
        );
    }
    if (
      config.hosts !== undefined &&
      (!Array.isArray(config.hosts) ||
        config.hosts.some((host) => typeof host !== "string"))
    ) {
      reject(`\`${what}.hosts\` must be an array of strings`);
    }
    const spec = config.module as string;
    let module: string;
    try {
      const fromPackage = createRequire(join(packageDir, "package.json"));
      module = fromPackage.resolve(
        isAbsolute(spec) || spec.startsWith(".")
          ? resolve(packageDir, spec)
          : spec,
      );
    } catch {
      return reject(
        `\`${what}.module\` could not resolve \`${spec}\` from ${packageDir}`,
      );
    }
    return {
      module,
      ...(config.hosts === undefined
        ? {}
        : { hosts: config.hosts as string[] }),
    };
  });
}

/**
 * The accepted `parseOptions` shape, enforced wherever one is declared.
 *
 * Only the three documented switches exist, and each is a boolean. An unknown
 * key is an error rather than an ignored one: the whole point of
 * `parseOptions` is that the scan understands it without executing anything,
 * so a key the scan does not understand cannot be honored later either.
 */
export function checkParseOptions(
  value: unknown,
  file: string,
  what: string,
  line = 1,
  column = 0,
): CustomTagParseOptions {
  if (!isRecord(value)) {
    failIn(file, `\`${what}\` must be an object literal`, line, column);
  }
  const result: CustomTagParseOptions = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key !== "text" &&
      key !== "preserveWhitespace" &&
      key !== "openTagOnly"
    ) {
      failIn(
        file,
        `\`${what}.${key}\` is not a parse option; expected \`text\`, \`preserveWhitespace\` or \`openTagOnly\``,
        line,
        column,
      );
    }
    if (typeof entry !== "boolean") {
      failIn(file, `\`${what}.${key}\` must be a boolean`, line, column);
    }
    result[key] = entry;
  }
  return result;
}

/**
 * Reads a sidecar's `parseOptions` without executing it.
 *
 * The file is parsed with core's own Babel (`coreBabel()`, `@babel/parser`).
 *
 * The accepted shape is narrow and stated here because an author hits it as a
 * diagnostic: the module's `export default` must be an object literal, or an
 * identifier bound once at module scope to an object literal (the form every
 * sidecar in this repo uses, since it needs the `CustomTag` type annotation).
 * Within that literal, `parseOptions` must itself be an object literal of
 * boolean-valued known keys. Anything else — a spread, a call, a conditional,
 * a value imported from elsewhere — cannot be read without running code, so
 * it is a positioned diagnostic rather than a guess.
 *
 * A sidecar with no `parseOptions` at all is not an error: it simply declares
 * none, which is the common case.
 */
export function readParseOptions(
  source: string,
  file: string,
): CustomTagParseOptions | undefined {
  const babel = coreBabel();
  let ast: {
    program: { body: Array<Record<string, unknown>> };
  };
  try {
    ast = babel.parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
      // A sidecar is a module, not a file Babel should resolve config for.
      configFile: false,
      babelrc: false,
    });
  } catch (cause) {
    const loc = (cause as { loc?: { line?: number; column?: number } }).loc;
    failIn(
      file,
      `could not be parsed: ${dropOwnParserPosition(cause, (cause as Error).message)}`,
      loc?.line ?? 1,
      loc?.column ?? 0,
    );
  }

  const body = ast.program.body;
  const defaultExport = body.find(
    (node) => node.type === "ExportDefaultDeclaration",
  ) as { declaration?: Record<string, unknown> } | undefined;
  if (!defaultExport?.declaration) return undefined;

  const literal = resolveObjectLiteral(defaultExport.declaration, body);
  if (!literal) return undefined;

  const property = findProperty(literal, "parseOptions");
  if (!property) return undefined;

  const loc = (property.loc as { start?: { line: number; column: number } })
    ?.start;
  const value = property.value as Record<string, unknown>;
  if (value?.type !== "ObjectExpression") {
    failIn(
      file,
      "`parseOptions` must be an object literal, so the scan can read it without executing the sidecar",
      loc?.line ?? 1,
      loc?.column ?? 0,
    );
  }

  return checkParseOptions(
    literalToValue(value, file),
    file,
    "parseOptions",
    loc?.line ?? 1,
    loc?.column ?? 0,
  );
}

/**
 * Resolves `export default X` to the object literal it names, following at
 * most one module-scope binding. `export default { ... }` and
 * `const t: CustomTag = { ... }; export default t;` are the two forms.
 */
function resolveObjectLiteral(
  declaration: Record<string, unknown>,
  body: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (declaration.type === "ObjectExpression") return declaration;
  if (declaration.type !== "Identifier") return null;

  const name = declaration.name as string;
  for (const statement of body) {
    const node =
      statement.type === "ExportNamedDeclaration"
        ? (statement.declaration as Record<string, unknown> | undefined)
        : statement;
    if (node?.type !== "VariableDeclaration") continue;
    for (const raw of node.declarations as Array<Record<string, unknown>>) {
      const id = raw.id as { type?: string; name?: string } | undefined;
      if (id?.type !== "Identifier" || id.name !== name) continue;
      const init = raw.init as Record<string, unknown> | undefined;
      if (!init) return null;
      if (init.type === "ObjectExpression") return init;
      // `satisfies`/`as` wrappers keep the literal one level down.
      if (
        init.type === "TSSatisfiesExpression" ||
        init.type === "TSAsExpression"
      ) {
        const inner = init.expression as Record<string, unknown>;
        if (inner?.type === "ObjectExpression") return inner;
      }
      return null;
    }
  }
  return null;
}

/**
 * Where the property `name` is written in the object literal a module
 * `export default`s, read with Babel without executing the module: the
 * property's key. `undefined` when the module does not parse, its default
 * export is not a literal (or an identifier bound once to one), or the key is
 * not there (a spread, a computed key).
 */
function staticKeyPosition(
  file: string,
  name: string,
): { line: number; column: number } | undefined {
  return staticKeyPathPosition(file, [name]);
}

/** `value` without its `satisfies`/`as` wrappers. */
function unwrapTypeAssertions(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  let node = value;
  while (
    node?.type === "TSSatisfiesExpression" ||
    node?.type === "TSAsExpression"
  ) {
    node = node.expression as Record<string, unknown>;
  }
  return node;
}

/**
 * {@link staticKeyPosition} along a key path (`["contracts", "card"]`): each
 * key's value is itself an object literal, or an identifier bound once at
 * module scope to one (through `satisfies`/`as`), and the last key's
 * position is returned. `undefined` as soon as one step cannot be read
 * without running the module.
 */
export function staticKeyPathPosition(
  file: string,
  path: readonly string[],
): { line: number; column: number } | undefined {
  try {
    const ast = coreBabel().parse(readFileSync(file, "utf8"), {
      sourceType: "module",
      plugins: ["typescript"],
      configFile: false,
      babelrc: false,
    }) as { program: { body: Array<Record<string, unknown>> } };
    const body = ast.program.body;
    const defaultExport = body.find(
      (node) => node.type === "ExportDefaultDeclaration",
    ) as { declaration?: Record<string, unknown> } | undefined;
    // `export default { … } satisfies ContractMap`: the literal is one level down.
    let value = unwrapTypeAssertions(defaultExport?.declaration);
    let key: { loc?: { start?: { line: number; column: number } } } | undefined;
    for (const name of path) {
      if (!value) return undefined;
      const literal = resolveObjectLiteral(value, body);
      const property = literal ? findProperty(literal, name) : undefined;
      if (!property) return undefined;
      key = property.key as typeof key;
      value = unwrapTypeAssertions(
        property.value as Record<string, unknown> | undefined,
      );
    }
    const start = key?.loc?.start;
    return start ? { line: start.line, column: start.column } : undefined;
  } catch {
    return undefined;
  }
}

function findProperty(
  object: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const properties = object.properties as
    | Array<Record<string, unknown>>
    | undefined;
  if (!properties) return undefined;
  return properties.find((property) => {
    if (property.type !== "ObjectProperty" || property.computed) return false;
    const key = property.key as {
      type?: string;
      name?: string;
      value?: string;
    };
    return (
      (key.type === "Identifier" && key.name === name) ||
      (key.type === "StringLiteral" && key.value === name)
    );
  });
}

/**
 * Converts an object literal of boolean literals to a plain value.
 *
 * Deliberately total: anything that is not a boolean literal becomes a
 * non-boolean here, and `checkParseOptions` reports it against the declared
 * key, so the diagnostic names the option rather than an AST node type.
 */
function literalToValue(
  object: Record<string, unknown>,
  file: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (object.properties ?? []) as Array<
    Record<string, unknown>
  >;
  for (const property of properties) {
    if (property.type !== "ObjectProperty" || property.computed) {
      const loc = (property.loc as { start?: { line: number; column: number } })
        ?.start;
      failIn(
        file,
        "`parseOptions` must be a plain object literal; a spread or computed key cannot be read without executing the sidecar",
        loc?.line ?? 1,
        loc?.column ?? 0,
      );
    }
    const key = property.key as { name?: string; value?: string };
    const value = property.value as { type?: string; value?: unknown };
    result[(key.name ?? key.value) as string] =
      value?.type === "BooleanLiteral" ? value.value : (value?.type ?? null);
  }
  return result;
}

/**
 * Loads a sidecar's hooks, synchronously, through the runtime's own loader.
 *
 * `require`, not `import()`: every caller is synchronous (see the module
 * doc). Both supported runtimes handle a `.ts` file here without a transform
 * from MX — Bun natively, Node by stripping types on `require`.
 *
 * A module that throws while evaluating, or that does not default-export an
 * object, becomes a `TranslateError` naming the file. That is the difference
 * between the language server reporting a diagnostic and the language server
 * dying.
 *
 * **Two constraints on a sidecar**, because the two runtimes that load one do
 * not accept exactly the same module. Both are measured, not inferred:
 *
 * - **No top-level `await`.** Bun loads it; Node refuses with `require() cannot
 *   be used on an ESM graph with top-level await`.
 * - **Explicit extensions on relative imports.** `./helper` resolves on Bun;
 *   Node refuses with `Cannot find module`. Write `./helper.ts`.
 *
 * A sidecar is compile-time configuration, so neither costs an author anything
 * real — but a sidecar that violates one works in a `bun` build and fails in
 * the editor, which is exactly the disagreement a single loader exists to
 * prevent. The catch below names the file and, when the runtime's own message
 * identifies one of these two, restates the constraint rather than leaving an
 * author to map Node's wording onto their sidecar.
 *
 * The runtime's module cache is dropped for this file first. The scan cache
 * already notices an edited sidecar and rebuilds its entry, but a long-lived
 * process would then `require` the same path and be handed the *previous*
 * evaluation — so an author's edit would change the tag's `parseOptions` and
 * not its hooks. Evicting here rather than in the cache keeps the two facts
 * together: whoever loads the module is who must decide it is stale.
 */
function sidecarHint(message: string, what = "custom tag sidecar"): string {
  if (message.includes("top-level await")) {
    return ` — a ${what} may not use top-level \`await\`, because it is loaded synchronously before the calling file is parsed`;
  }
  if (message.includes("Cannot find module")) {
    return ` — a ${what}'s relative imports need explicit extensions (\`./helper.ts\`, not \`./helper\`)`;
  }
  return "";
}

export function loadDefaultExport(
  file: string,
  what: "sidecar" | "contracts module" | "dialect",
): Record<string, unknown> {
  let module: { default?: unknown } | undefined;
  try {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    module = require(file) as { default?: unknown };
  } catch (cause) {
    if (isTranslateError(cause) && cause.file !== undefined) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    const fail = what === "sidecar" ? failIn : failContracts;
    fail(
      file,
      `${what} failed to load: ${message}${sidecarHint(message, what === "sidecar" ? "custom tag sidecar" : what)}`,
    );
  }
  const definition = module?.default;
  if (!isRecord(definition)) {
    const fail = what === "sidecar" ? failIn : failContracts;
    fail(
      file,
      `${what} must \`export default\` ${what === "sidecar" ? "a CustomTag object" : what === "dialect" ? "a dialect object (`{ table, lowerTrigger?, … }`)" : "a plain ContractMap object"}`,
    );
  }
  return definition as Record<string, unknown>;
}

export function loadSidecar(file: string): CustomTag {
  return loadDefaultExport(file, "sidecar") as CustomTag;
}

/**
 * Wraps one discovered tag as a `CustomTag` whose hooks load on first use.
 *
 * `parseOptions` is already known statically and is present eagerly, because
 * the taglib is built before the caller parses. Everything else is a getter
 * that loads the sidecar once, so a project with fifty tags evaluates only
 * the modules a file actually calls.
 */
function lazyTag(tag: DiscoveredTag, claimed: ClaimedFields): CustomTag {
  const definition: CustomTag = {};
  if (tag.parseOptions) definition.parseOptions = tag.parseOptions;

  // The `x.mx` template, when one exists, read on first use. A tag with a
  // template and no sidecar (L1-only) is complete as it stands: the call
  // routes to the template's own compiled module. A tag with both is
  // composed — the sidecar's `transform` wins and may route the call to this
  // template through `ctx.build.template(call)` — so the template is attached
  // either way.
  //
  // Read lazily, and re-read per scan rather than cached here, for the same
  // reason the sidecar hooks are lazy: a project with fifty tags should touch
  // only the files a compilation actually calls. The unit's own metadata cache
  // (keyed by path, mtime and source) is what keeps repeated calls cheap.
  if (tag.template) {
    const path = tag.template;
    Object.defineProperty(definition, "template", {
      enumerable: true,
      configurable: true,
      get: (): TemplateTag => ({
        filename: path,
        source: readFileSync(path, "utf8"),
        mtimeMs: statSync(path).mtimeMs,
      }),
    });
  }

  const sidecar = tag.sidecar;
  if (!sidecar) return definition;

  let loaded: CustomTag | undefined;
  const load = (): CustomTag => {
    if (loaded) return loaded;
    const candidate = loadSidecar(sidecar);
    // Validate the sidecar's own declarations while its origin is known.
    // The merged-map checks still run later for cross-tag relationships.
    // A paired template makes a finalize-only sidecar reachable.
    try {
      const own = { [tag.name]: candidate };
      rejectUnknownDeclarationKeys(own, claimed, undefined, (_name, key) => {
        const at = staticKeyPathPosition(sidecar, [key]);
        return at && { ...at, file: sidecar };
      });
      if (!tag.template) rejectUnreachableHooks(own);
    } catch (cause) {
      // The file's dialect did not resolve: that is the error, not a
      // key it might have claimed.
      if (claimed.failure !== undefined) throw claimed.failure;
      if (isTranslateError(cause) && cause.file === undefined)
        withCodeOf(cause, () => failIn(sidecar, cause.message));
      throw cause;
    }
    loaded = candidate;
    return loaded;
  };

  for (const key of [
    "attributes",
    "attributeTags",
    "children",
    "parents",
    "defaultTag",
  ] as const) {
    Object.defineProperty(definition, key, {
      enumerable: true,
      configurable: true,
      get: () => load()[key],
    });
  }
  // The keys the file's dialect claims are its data: carried as written.
  for (const key of claimed.tag) {
    Object.defineProperty(definition, key, {
      enumerable: true,
      configurable: true,
      get: () => (load() as Record<string, unknown>)[key],
    });
  }
  for (const key of ["analyze", "transform", "finalize"] as const) {
    Object.defineProperty(definition, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        const hook = load()[key];
        return hook ? hook.bind(loaded) : undefined;
      },
    });
  }
  return definition;
}

/** The contract keys a dialect tag file supplies (the hooks stay the sidecar's). */
/** The keys of a `CustomTag` an `mx.contracts` entry may state (no `transform`, `finalize` or `template`). */
const MX_CONTRACTS_KEYS: readonly string[] = [
  "parseOptions",
  "attributes",
  "attributeTags",
  "children",
  "parents",
  "defaultTag",
  "analyze",
];

const TAG_FILE_CONTRACT_KEYS = [
  "attributes",
  "attributeTags",
  "children",
  "parents",
  "defaultTag",
] as const;

/**
 * How a dialect tag file's contract is read: set by `tag-file.ts` as it
 * loads (it runs the dialect's `tagFile` hook through `lowerSource`, which
 * this module must not import). Unset, every read is the hookless error.
 */
let tagFileReader: ((tag: DiscoveredTag) => DeferredReader) | undefined;

/** Registers how a dialect tag file's contract is read (`tag-file.ts`). Internal. */
export function registerTagFileReader(
  reader: (tag: DiscoveredTag) => DeferredReader,
): void {
  tagFileReader = reader;
}

/**
 * The error a dialect tag file's contract raises while its dialect has no
 * way to read it: unpositioned, so the custom-tag call that read it places
 * it at the call.
 */
export function tagFileError(tag: DiscoveredTag): TranslateError {
  const file = tag.tagFile as string;
  const shown = relative(dirname(tag.sourceDir ?? dirname(file)), file)
    .split("\\")
    .join("/");
  const error = new TranslateError(
    `\`<${tag.name}>\` is defined by ${shown}, but dialect \`${tag.dialect}\` has no tagFile hook to read it.`,
    0,
    0,
  );
  error.diagnosticCode = "MX_TAG_FILE_ERROR";
  return error;
}

/** The reader of a tag file while no `tagFile` reader is registered. */
function hooklessReader(tag: DiscoveredTag): DeferredReader {
  let read: { error: TranslateError } | undefined;
  return {
    read: () => {
      read ??= { error: tagFileError(tag) };
      return read;
    },
    stale: () => false,
  };
}

/**
 * Wraps a dialect tag file as a `CustomTag`. Names and static `parseOptions`
 * register like any tag's; the contract is what the dialect's `tagFile` hook
 * derives from the file (`tag-file.ts`), read through a reader, and the
 * contract keys are getters over it that throw when it cannot be read
 * (without a hook, `MX_TAG_FILE_ERROR`). The entry is branded
 * (`deferContract`), so registration skips its contract and the first call
 * reads it, where an error lands at the call. A paired `.tag.ts` sidecar
 * supplies the hooks, loaded lazily as `lazyTag` loads them. The scan itself
 * reads none of these getters and runs no hook.
 */
function dialectTag(tag: DiscoveredTag, claimed: ClaimedFields): CustomTag {
  const definition: CustomTag = {};
  if (tag.parseOptions) definition.parseOptions = tag.parseOptions;
  // Chosen at the first read, not here: a scan may run before
  // `tag-file.ts` has registered (an entry point that imports only the scan).
  let chosen: DeferredReader | undefined;
  const choose = (): DeferredReader => {
    chosen ??= tagFileReader?.(tag) ?? hooklessReader(tag);
    return chosen;
  };
  const reader: DeferredReader = {
    read: (call) => choose().read(call),
    stale: (pass) => chosen?.stale(pass) ?? false,
    get definedIn() {
      return choose().definedIn;
    },
  };
  const contractKeys = [...TAG_FILE_CONTRACT_KEYS, ...claimed.tag];
  for (const key of contractKeys) {
    Object.defineProperty(definition, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        const read = reader.read(false);
        if (read.error !== undefined) throw read.error;
        return (read.contract as Record<string, unknown> | undefined)?.[key];
      },
    });
  }
  if (tag.sidecar) {
    const hooks = lazyTag({ name: tag.name, sidecar: tag.sidecar }, claimed);
    for (const key of ["analyze", "transform", "finalize"] as const) {
      Object.defineProperty(definition, key, {
        enumerable: true,
        configurable: true,
        get: () => hooks[key],
      });
    }
  }
  markContractKeys(definition, contractKeys);
  return deferContract(definition, reader);
}

/**
 * `package.json` reads go through the shared mtime-keyed reader
 * (`package-json.ts`), which `host-policy.ts` also uses.
 *
 * `JSON.parse` on every scan is real work repeated for every file a project
 * compiles, and a parse failure mid-edit used to silently set `manifest =
 * undefined` — dropping every `mx.tags` entry, with no diagnostic, for as
 * long as the file stayed broken. Both are fixed there: the parsed manifest
 * is reused while the file's mtime is unchanged, and a parse failure keeps
 * the *previous* good manifest in force (an editor mid-save is not a reason
 * to make every open file's tags disappear) while still surfacing a
 * diagnostic — into *every* `ScanResult` a caller builds against this broken
 * revision, not merely the first one that happened to hit the parse error.
 * That diagnostic is built once per broken revision (`brokenDiagnostics`) and
 * re-pushed into every caller's own `diagnostics` array on a cache hit;
 * per-scan-result dedup is `scanCached`'s job (its outer cache short-circuits
 * before `readManifest` is even called again for an unchanged directory).
 */
const brokenDiagnostics = new WeakMap<PackageJsonParseError, ScanDiagnostic>();

/** For tests: drops every cached `package.json` read. */
export function clearManifestCache(): void {
  clearPackageJsonCache();
}

function readManifest(
  packageJson: string,
  diagnostics: ScanDiagnostic[],
): { mx?: { tags?: unknown; contracts?: unknown } } | undefined {
  const read = readPackageJsonCached(packageJson);
  if (!read) return undefined;

  const { error } = read;
  if (error) {
    let diagnostic = brokenDiagnostics.get(error);
    if (!diagnostic) {
      diagnostic = {
        file: packageJson,
        message: `\`package.json\` could not be parsed as JSON: ${error.message}; ${read.manifest === undefined ? "no `mx.tags` or `mx.contracts` are loaded until the manifest parses" : "the previous valid `mx.tags` and `mx.contracts` stay in force"}`,
        line: 1,
        column: 0,
      };
      brokenDiagnostics.set(error, diagnostic);
    }
    diagnostics.push(diagnostic);
  }
  return read.manifest as
    | { mx?: { tags?: unknown; contracts?: unknown } }
    | undefined;
}

interface IndexOptions {
  /** Directory-level defaults from an `mx.tags` entry. */
  prefix?: string;
  parseOptions?: CustomTagParseOptions;
  /** The `mx.tags` entry's `hosts` restriction, carried onto each tag found. */
  hosts?: string[];
  /** The caller's discovery; core's own when absent. */
  discovery?: TagDiscovery;
  /** The scan's project routing, for file names a dialect claims. */
  routes?: Routes;
  /**
   * Where a reserved name defined by this directory is reported, when that
   * is not the tag file itself: an `mx.tags` entry is reported at its config
   * file.
   */
  refuseAt?: () => { file: string; line: number; column: number };
}

const CORE_RESERVED: ReadonlySet<string> = new Set(RESERVED_NAMES);

/**
 * Why `name` may not be defined as a tag for `discovery`'s caller, or
 * `undefined` when it may. Core's structural names are refused for every
 * caller; a dialect's own `reservedTags` are refused for its own caller. Core
 * is dialect zero: its fixed entry carries `RESERVED_NAMES` as `reservedTags`,
 * so both go through this one check. `source` names what defined the tag
 * (`a tag file`, `` `mx.contracts` ``, `` `customTags` ``).
 */
export function reservedRefusal(
  name: string,
  discovery: Pick<TagDiscovery, "name" | "reservedTags">,
  source: string,
): string | undefined {
  if (CORE_RESERVED.has(name)) return reservedNameMessage(name);
  if (discovery.reservedTags.includes(name)) {
    return dialectReservedMessage(name, source, discovery.name);
  }
  return undefined;
}

/**
 * The `MX_RESERVED_TAG` diagnostic for a tag file: the file's own 1:0, or,
 * for a directory an `mx.tags` entry named, the config file at that entry
 * (with the file named in the message, since the position is elsewhere).
 */
function reservedFileDiagnostic(
  message: string,
  path: string,
  options: IndexOptions,
): ScanDiagnostic {
  const at = options.refuseAt?.();
  return {
    file: at?.file ?? path,
    message: at ? `${message} (${path})` : message,
    line: at?.line ?? 1,
    column: at?.column ?? 0,
    severity: "error",
    code: RESERVED_TAG_CODE,
  };
}

/** `components/` or `components/` and `concepts/`, for a message. */
function dirList(dirs: readonly string[]): string {
  const shown = dirs.map((dir) => `\`${dir}/\``);
  return shown.length <= 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}`;
}

/**
 * MX's kinds skip a file a dialect with `tagDirs` claims: it is that
 * dialect's tag file, never an MX template. When it sits in a directory the
 * dialect does not read, the author is told where it goes (`true`: skip).
 * A dialect without `tagDirs` claims nothing here, so its files keep MX's
 * handling (and a dotted `.mx` name its dotted-name diagnostic).
 */
function skipClaimedFile(
  dir: string,
  entry: string,
  routes: Routes | undefined,
  diagnostics: ScanDiagnostic[],
): boolean {
  if (!routes || entry.endsWith(SIDECAR_SUFFIX)) return false;
  const router = routes(dir);
  if (!router?.dialects.some((dialect) => dialect.tagDirs !== undefined)) {
    return false;
  }
  const owner = routeOf(routes, dir, entry)?.dialect;
  if (owner?.tagDirs === undefined) return false;
  const here = basename(dir);
  if (!owner.tagDirs.includes(here)) {
    diagnostics.push({
      file: join(dir, entry),
      message: `\`${here}/${entry}\` is a ${owner.name} file in \`${here}/\`; ${owner.name} discovers tags in ${dirList(owner.tagDirs)}.`,
      line: 1,
      column: 0,
      severity: "warning",
      code: "MX_MISPLACED_TAG_FILE",
    });
  }
  return true;
}

/**
 * The `MX_INVALID_TAG_FILE_NAME` diagnostic: a tag file whose name cannot be
 * a tag name, in MX's own `tags/` and in a dialect's `tagDirs` alike. An
 * error at the file's own 1:0; the file is skipped, the rest of the scan goes
 * on.
 */
function invalidTagFileNameDiagnostic(
  dir: string,
  entry: string,
  bare: string,
): ScanDiagnostic {
  return {
    file: join(dir, entry),
    message: `\`${basename(dir)}/${entry}\` is skipped: \`${bare}\` is not a usable tag name; a tag file's name must start with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots`,
    line: 1,
    column: 0,
    severity: "error",
    code: "MX_INVALID_TAG_FILE_NAME",
  };
}

/**
 * Indexes one directory of a dialect's tag files (`kind: "tag-files"`):
 * each file ending in a claimed extension that routes to this dialect, named
 * by its basename minus that extension (the longest claimed one), plus
 * `.tag.ts` sidecars unless `sidecars` is off. A file another dialect claims
 * is that dialect's (two dialects may share a directory), and `.mx`
 * templates are never read: no dialect claims `.mx`. A bad name is a
 * positioned error and the file is skipped, never a throw.
 */
function indexTagFiles(
  dir: string,
  entries: readonly string[],
  into: Map<string, DiscoveredTag>,
  files: Array<{ path: string; mtimeMs: number }>,
  diagnostics: ScanDiagnostic[],
  options: IndexOptions,
  discovery: TagDiscovery,
): void {
  const here = basename(dir);
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry);
    const isSidecar = entry.endsWith(SIDECAR_SUFFIX);
    let bare: string;
    let claim: DialectRoute | undefined;
    if (isSidecar) {
      if (!discovery.sidecars) {
        diagnostics.push({
          file: path,
          message: `\`${here}/${entry}\` is ignored: ${discovery.name} tag directories do not read \`.tag.ts\` sidecars (\`sidecars: false\`)`,
          line: 1,
          column: 0,
          severity: "warning",
          code: "MX_SIDECAR_IGNORED",
        });
        continue;
      }
      bare = entry.slice(0, -SIDECAR_SUFFIX.length);
    } else {
      claim = options.routes ? routeOf(options.routes, dir, entry) : undefined;
      if (claim?.dialect.id !== discovery.id) continue;
      bare = entry.slice(0, -claim.extension.length);
    }
    if (!TAG_NAME_RE.test(bare)) {
      diagnostics.push(invalidTagFileNameDiagnostic(dir, entry, bare));
      continue;
    }
    if (claim && bare.includes(".")) {
      const first = bare.slice(0, bare.indexOf("."));
      const suffix = `${bare.slice(bare.indexOf("."))}${claim.extension}`;
      diagnostics.push({
        file: path,
        message: `\`${here}/${entry}\` is named \`<${bare}>\`, which a call cannot write as one tag name; declare \`${suffix}\` in \`tagExtensions\` to name it \`<${first}>\``,
        line: 1,
        column: 0,
        severity: "warning",
        code: "MX_DOTTED_TAG_FILE_NAME",
      });
    }
    const name = `${options.prefix ?? ""}${bare}`;
    const refusal = reservedRefusal(name, discovery, "a tag file");
    if (refusal !== undefined) {
      diagnostics.push(reservedFileDiagnostic(refusal, path, options));
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const existing = into.get(name);
    if (existing && existing.sourceDir !== dir) continue;
    const record = { path, mtimeMs };
    files.push(record);
    const tag: DiscoveredTag = existing ?? {
      name,
      sourceDir: dir,
      hosts: options.hosts,
    };
    if (isSidecar) {
      tag.sidecar = path;
      const declared = readParseOptions(readScanned(path, record), path);
      const merged = { ...options.parseOptions, ...declared };
      if (Object.keys(merged).length > 0) tag.parseOptions = merged;
    } else {
      tag.tagFile = path;
      tag.dialect = discovery.id;
      if (!tag.sidecar && options.parseOptions) {
        tag.parseOptions = { ...options.parseOptions };
      }
    }
    into.set(name, tag);
  }
}

/**
 * Indexes one directory of tag files into `into`, without overwriting a tag a
 * nearer directory already claimed.
 *
 * Only `.mx` and `.tag.ts` are tag files; anything else in a `tags/`
 * directory (a README, a test, a `.css`) is ignored rather than reported, so
 * a `tags/` directory can hold the things a directory normally holds.
 */
function indexDirectory(
  dir: string,
  into: Map<string, DiscoveredTag>,
  files: Array<{ path: string; mtimeMs: number }>,
  diagnostics: ScanDiagnostic[],
  dottedTagFiles: DottedTagFile[],
  options: IndexOptions = {},
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const discovery = options.discovery ?? CORE_TAG_DISCOVERY;

  // Sorted so a directory holding both `x.mx` and `x.tag.ts` indexes them in
  // a fixed order regardless of the filesystem's own enumeration.
  entries.sort();
  if (discovery.kind === "tag-files") {
    indexTagFiles(dir, entries, into, files, diagnostics, options, discovery);
    return;
  }
  for (const entry of entries) {
    // A dotfile is never a tag. `.DS_Store.mx` would otherwise register as
    // `<.DS_Store>` and `tags/.mx` as a tag with no name at all; see
    // `TAG_NAME_RE`.
    if (entry.startsWith(".")) continue;

    const isSidecar = entry.endsWith(SIDECAR_SUFFIX);
    if (isSidecar && !discovery.sidecars) {
      diagnostics.push({
        file: join(dir, entry),
        message: `\`${basename(dir)}/${entry}\` is ignored: ${discovery.name} tag directories do not read \`.tag.ts\` sidecars (\`sidecars: false\`)`,
        line: 1,
        column: 0,
        severity: "warning",
        code: "MX_SIDECAR_IGNORED",
      });
      continue;
    }

    if (skipClaimedFile(dir, entry, options.routes, diagnostics)) continue;
    if (rejectUncallableTagFile(dir, entry, diagnostics, dottedTagFiles))
      continue;
    const isTemplate = entry.endsWith(TEMPLATE_SUFFIX);

    if (!isSidecar && !isTemplate) continue;

    const bare = isSidecar
      ? basename(entry, SIDECAR_SUFFIX)
      : basename(entry, TEMPLATE_SUFFIX);
    if (!TAG_NAME_RE.test(bare)) {
      diagnostics.push(invalidTagFileNameDiagnostic(dir, entry, bare));
      continue;
    }
    const path = join(dir, entry);
    const name = `${options.prefix ?? ""}${bare}`;

    // A reserved name (core's structural names, `<try>` among them, or the
    // caller's dialect's `reservedTags`) cannot be defined by a tag file. A
    // `<try>` definition makes `rejectShadowedRegistration` refuse the *whole*
    // map, so handing the name onward would break every file in the package
    // over one misnamed file. Reported and skipped instead, the same way a
    // misconfigured `mx.tags` entry is: the author is told, and everything
    // else keeps working, with the call resolving as if there were no file.
    const refusal = reservedRefusal(name, discovery, "a tag file");
    if (refusal !== undefined) {
      diagnostics.push(reservedFileDiagnostic(refusal, path, options));
      continue;
    }

    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }

    // Nearest directory wins: a name already claimed by a nearer `tags/` dir
    // is not overwritten, and neither half of it is re-read here.
    const existing = into.get(name);
    if (existing && existing.sourceDir !== dir) continue;

    const record = { path, mtimeMs };
    files.push(record);
    const tag: DiscoveredTag = existing ?? {
      name,
      sourceDir: dir,
      hosts: options.hosts,
    };
    if (isSidecar) {
      tag.sidecar = path;
      // The sidecar's own declaration overrides the directory default, which
      // is what "directory-level defaults a sidecar may override" means.
      const declared = readParseOptions(readScanned(path, record), path);
      const merged = { ...options.parseOptions, ...declared };
      if (Object.keys(merged).length > 0) tag.parseOptions = merged;
    } else {
      tag.template = path;
      if (!tag.sidecar && options.parseOptions) {
        tag.parseOptions = { ...options.parseOptions };
      }
    }
    into.set(name, tag);
  }
}

export interface ScanOptions {
  /**
   * The registered targets this scan runs under (decisions 129 and 132).
   * Required, never defaulted: which file-kind segments exist is an open-set
   * question — the scan needs it to tell a host module file from a tag
   * template, and core holds no list to fall back on, so a scan without one
   * would silently index a `<x.ng>.mx` a caller had every reason to reject.
   * It is deliberately not part of the cached scan's identity (see
   * `scan-cache.ts`): the tag set is lookup-neutral and dotted-file wording
   * is derived for each caller, including own-only and registry callers.
   */
  targets: TargetLookup;
  /**
   * Stops the upward walk at this directory, for a test that must not reach
   * the real repository above its fixture. Defaults to the package root (the
   * nearest `package.json`), as the spec describes.
   */
  stopAt?: string;
  /**
   * The value `mx.tags[].hosts` is matched against for the target this file
   * compiles under (`host.name`, or a hostless target's legacy `mx.host`
   * value — read it off the caller's lookup with `hostFilterKey`, not guessed
   * from the target name). A tag whose `mx.tags` entry declared `hosts`
   * excluding this value is left out of `tags` and `customTags` entirely —
   * not merely hidden, since a name a different host owns must stay callable
   * from that host's own scan of the same file. A tag with no `hosts`
   * restriction (every local `tags/` directory, and any `mx.tags` entry that
   * did not declare `hosts`) is visible to every host, `host` unset included.
   * null excludes every restricted entry: this target has no host filter key.
   * undefined intentionally disables filtering for project-wide discovery.
   */
  host?: string | null;
}

/** Whether an entry competes for this caller; undefined disables filtering. */
function appliesToHost(
  hosts: readonly string[] | undefined,
  host: string | null | undefined,
): boolean {
  return (
    !hosts || host === undefined || (host !== null && hosts.includes(host))
  );
}

/**
 * Applies a `host` restriction to an in-progress scan's tags, in place.
 *
 * A `hosts` restriction excludes the tag from the result entirely, not
 * merely from `customTags`: a name a different host owns must stay
 * resolvable (e.g. as "not visible here") rather than appear to exist with
 * no map entry backing it. Shared by `scanCustomTags` and
 * `discoverProjectTags`, so the rule cannot drift between the two.
 */
function applyHostFilter(
  tags: Map<string, DiscoveredTag>,
  host: string | null,
): void {
  for (const [name, tag] of tags) {
    if (!appliesToHost(tag.hosts, host)) tags.delete(name);
  }
}

/** Builds the lazy `customTags` map a compiler consumes from a tag map. */
function buildCustomTags(
  tags: Map<string, DiscoveredTag>,
  claimed: ClaimedFields,
): Record<string, CustomTag> {
  const customTags: Record<string, CustomTag> = Object.create(null);
  for (const [name, tag] of tags)
    customTags[name] =
      tag.contract ??
      (tag.tagFile ? dialectTag(tag, claimed) : lazyTag(tag, claimed));
  return customTags;
}

/**
 * Indexes one package's `mx.tags` entries into `tags`, lowest precedence: a
 * name a local `tags/` directory already claimed is left alone. Shared by
 * `scanCustomTags` and `discoverProjectTags`, which each locate their own
 * `packageDir`/`packageJson` first (by walking upward, or by taking the
 * project root) and then index identically from there.
 */
function indexMxTagsEntries(
  packageDir: string,
  packageJson: string,
  mx: { tags?: unknown; contracts?: unknown } | undefined,
  tags: Map<string, DiscoveredTag>,
  files: Array<{ path: string; mtimeMs: number }>,
  diagnostics: ScanDiagnostic[],
  directories: string[],
  dottedTagFiles: DottedTagFile[],
  hostRestrictions: HostRestriction[],
  host: ScanOptions["host"],
  claimed: ClaimedFields,
  scope: Pick<IndexOptions, "discovery" | "routes"> = {},
): void {
  const entries = normalizeMxTags(mx?.tags, packageDir, packageJson);
  // `normalizeMxTags` maps an array one entry to one entry (an invalid one
  // throws), so the loop index is the authored index; a string is no entry.
  const authored = Array.isArray(mx?.tags);
  for (const [entryIndex, entry] of entries.entries()) {
    directories.push(entry.dir);
    if (!existsSync(entry.dir)) {
      // Recorded, not thrown: see `ScanResult.diagnostics`.
      diagnostics.push({
        file: packageJson,
        message: `\`mx.tags\` names a directory that does not exist: ${entry.dir}`,
        line: 1,
        column: 0,
      });
      continue;
    }
    if (entry.hosts) {
      // Recorded, not decided: an unknown host name must not silently drop
      // the tag from every host's discovery (see `applyHostFilter`) with
      // nothing said — the entry still indexes, just under a name nothing
      // will ever match. Whether the name is known is the caller's lookup's
      // answer (`hostRestrictionDiagnostics`), so the scan only records it.
      for (const host of entry.hosts) {
        hostRestrictions.push({ file: packageJson, host, line: 1, column: 0 });
      }
    }
    // Resolve precedence only among directories available to this caller.
    if (!appliesToHost(entry.hosts, host)) continue;
    indexDirectory(entry.dir, tags, files, diagnostics, dottedTagFiles, {
      ...scope,
      prefix: entry.prefix,
      parseOptions: entry.parseOptions,
      hosts: entry.hosts,
      // A reserved name in this directory is reported at this entry in the
      // config file (the `tags` key for a single string).
      refuseAt: () => ({
        file: packageJson,
        ...mxTagsEntryPosition(packageJson, authored ? entryIndex : undefined),
      }),
    });
  }
  indexMxContractsEntries(
    mx?.contracts,
    packageDir,
    packageJson,
    tags,
    files,
    diagnostics,
    hostRestrictions,
    host,
    claimed,
    scope.discovery ?? CORE_TAG_DISCOVERY,
  );
}

/**
 * Indexes the `tags` and `contracts` of the MX config that applies to
 * `fromDir` (`mx-config.ts`: `mx.config.*`, `.mxrc*`, `package.json#mx`, or a
 * provided config). `packageJson` is the nearest manifest the caller found,
 * read here for its own parse diagnostic; with none, a config found above
 * `walkedTo` (the last directory the caller's walk reached) does not apply.
 * Every search place consulted lands in `configFiles` for invalidation.
 */
function indexMxConfig(
  fromDir: string,
  walkedTo: string,
  packageJson: string | undefined,
  configFiles: string[],
  tags: Map<string, DiscoveredTag>,
  files: Array<{ path: string; mtimeMs: number }>,
  diagnostics: ScanDiagnostic[],
  directories: string[],
  dottedTagFiles: DottedTagFile[],
  hostRestrictions: HostRestriction[],
  host: ScanOptions["host"],
  claimed: ClaimedFields,
  scope: Pick<IndexOptions, "discovery" | "routes"> = {},
): void {
  if (packageJson) readManifest(packageJson, diagnostics);
  // A dialect that sets `mxConfigTags: false` takes no definitions from the
  // MX config: its files see its `tagDirs`, its `contracts` and the caller's.
  if (scope.discovery?.mxConfigTags === false) return;
  const source = findMxConfig(fromDir);
  configFiles.push(...(source?.watch ?? mxConfigSearchPaths(fromDir)));
  if (!source) return;
  if (!packageJson && !isWithin(walkedTo, source.dir)) return;
  if (source.error) {
    diagnostics.push({
      file: source.file,
      message: `\`${basename(source.file)}\` could not be loaded: ${source.error.message}; ${source.config === undefined ? "no `tags` or `contracts` are loaded until it loads" : "the previous valid `tags` and `contracts` stay in force"}`,
      line: source.error.line,
      column: source.error.column,
    });
  }
  indexMxTagsEntries(
    source.dir,
    source.file,
    source.config,
    tags,
    files,
    diagnostics,
    directories,
    dottedTagFiles,
    hostRestrictions,
    host,
    claimed,
    scope,
  );
}

/** Whether `dir` is `root` or inside it. */
function isWithin(root: string, dir: string): boolean {
  const rel = relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Both discovery walks index modules after all file-backed tags. */
function indexMxContractsEntries(
  value: unknown,
  packageDir: string,
  packageJson: string,
  tags: Map<string, DiscoveredTag>,
  files: ScanResult["files"],
  diagnostics: ScanDiagnostic[],
  hostRestrictions: HostRestriction[],
  host: ScanOptions["host"],
  claimed: ClaimedFields,
  discovery: TagDiscovery,
): void {
  if (value === undefined) return;
  let position: ReturnType<typeof contractsPosition> | undefined;
  for (const entry of normalizeMxContracts(value, packageDir, packageJson)) {
    const file = entry.module;
    // Stamp before evaluation: a racing edit must read as stale.
    try {
      files.push({ path: file, mtimeMs: statSync(file).mtimeMs });
    } catch {
      failContracts(file, "contracts module could not be read");
    }
    for (const host of entry.hosts ?? []) {
      position ??= contractsPosition(packageJson);
      hostRestrictions.push({
        file: packageJson,
        host,
        ...position,
        key: "mx.contracts",
      });
    }
    const contracts: ContractMap = Object.create(null);
    // A key of an entry, where the module writes it as a literal.
    const locateContractKey: LocateTagKey = (tagName, key) => {
      const at = staticKeyPathPosition(file, [tagName, key]);
      return at && { ...at, file };
    };
    try {
      const exported = loadDefaultExport(file, "contracts module");
      const plain = (record: Record<string, unknown>): boolean => {
        const prototype = Object.getPrototypeOf(record);
        return prototype === Object.prototype || prototype === null;
      };
      if (!plain(exported))
        failContracts(
          file,
          "contracts module must `export default` a plain ContractMap object",
        );
      for (const [name, definition] of Object.entries(exported)) {
        if (!TAG_NAME_RE.test(name))
          failContracts(file, `\`${name}\` is not a usable tag name`);
        const refusal = reservedRefusal(name, discovery, "`mx.contracts`");
        if (refusal !== undefined) {
          diagnostics.push({
            file,
            message: refusal,
            ...(staticKeyPosition(file, name) ?? { line: 1, column: 0 }),
            severity: "error",
            code: RESERVED_TAG_CODE,
          });
          continue;
        }
        if (!isRecord(definition) || !plain(definition))
          failContracts(file, `\`<${name}>\` must be a plain CustomTag object`);
        for (const key of Object.getOwnPropertyNames(definition)) {
          if (MX_CONTRACTS_KEYS.includes(key) || claimed.tag.has(key)) continue;
          if (key === "declares") {
            failContracts(
              file,
              `\`<${name}>\`: \`declares\` is not allowed: no syntax module claims it (\`contractFields\`)`,
            );
          }
          // A `CustomTag` key this source does not take (a sidecar's).
          if ((CUSTOM_TAG_KEYS as readonly string[]).includes(key)) {
            failContracts(
              file,
              `\`<${name}>\`: \`${key}\` is not allowed in \`mx.contracts\`; use a tag sidecar for hooks other than \`analyze\` and for templates`,
            );
          }
          // A key no `CustomTag` has: the shared refusal, at the key, listing
          // what an \`mx.contracts\` entry accepts. The pass over the whole map
          // below can then only see keys this one let through.
          rejectUnknownTagKeys(
            name,
            definition,
            claimed,
            locateContractKey,
            MX_CONTRACTS_KEYS,
          );
        }
        if (
          definition.analyze !== undefined &&
          typeof definition.analyze !== "function"
        )
          failContracts(file, `\`<${name}>\`.analyze must be a function`);
        if (definition.parseOptions !== undefined) {
          checkParseOptions(
            definition.parseOptions,
            file,
            `${name}.parseOptions`,
          );
        }
        contracts[name] = definition as CustomTag;
      }
      rejectUnknownDeclarationKeys(
        contracts,
        claimed,
        undefined,
        locateContractKey,
      );
      rejectUnreachableHooks(contracts);
    } catch (cause) {
      // The file's dialect did not resolve: that is the error, not a
      // key it might have claimed.
      if (claimed.failure !== undefined) throw claimed.failure;
      if (isTranslateError(cause) && cause.file !== undefined) throw cause;
      withCodeOf(cause, () =>
        failContracts(
          file,
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }
    // Keep validation and stamps for all modules, but only applicable entries
    // compete or produce duplicate/shadow warnings for this caller.
    if (!appliesToHost(entry.hosts, host)) continue;
    for (const [name, contract] of Object.entries(contracts)) {
      const existing = tags.get(name);
      if (existing) {
        const winner =
          existing.module ?? existing.sidecar ?? existing.template ?? "";
        diagnostics.push({
          file: existing.module ? file : winner,
          line: 1,
          column: 0,
          message: existing.module
            ? `\`<${name}>\` is defined twice in \`mx.contracts\`: ${winner} and ${file}; the first module's whole entry wins`
            : `\`<${name}>\` from \`mx.contracts\` (${file}) is shadowed by ${winner}; the module's contract does not apply`,
        });
        continue;
      }
      tags.set(name, {
        name,
        module: file,
        contract,
        parseOptions: contract.parseOptions,
        hosts: entry.hosts,
      });
    }
  }
}

/** Preserve partial discovery inputs when no complete ScanResult can be returned. */
function withScanDependencies(
  files: ScanResult["files"],
  packageFiles: string[],
  scan: () => ScanResult,
): ScanResult {
  try {
    return scan();
  } catch (error) {
    if (isTranslateError(error)) {
      error.dependencies = [
        ...new Set([
          ...(error.dependencies ?? []),
          ...packageFiles,
          ...files.map((file) => file.path),
          ...(error.file ? [error.file] : []),
        ]),
      ];
    }
    throw error;
  }
}

/**
 * Scans for the custom tags callable from `filePath`.
 *
 * Precedence, highest first (spec §4): an explicit import in the template
 * (which the core resolves before ever consulting this map), then local
 * `tags/` directories with the nearest winning, then `package.json#mx.tags`
 * entries in array order, then `mx.contracts` modules in array order.
 */
export function scanCustomTags(
  filePath: string,
  options: ScanOptions,
): ScanResult {
  return scanWithDiscovery(filePath, options, callerTagDiscovery(filePath));
}

/**
 * {@link scanCustomTags} under a discovery the caller already resolved
 * (`scanCached` keys its cache by it). At each level of the upward walk it
 * reads the discovery's `tagDirs`: `tags/` for MX's own files and for a
 * dialect without `tagDirs`, the dialect's directories otherwise.
 */
export function scanWithDiscovery(
  filePath: string,
  options: ScanOptions,
  discovery: TagDiscovery,
): ScanResult {
  const tags = new Map<string, DiscoveredTag>();
  const directories: string[] = [];
  const packageFiles: string[] = [];
  const configFiles: string[] = [];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const diagnostics: ScanDiagnostic[] = [];
  const hostRestrictions: HostRestriction[] = [];
  const dottedTagFiles: DottedTagFile[] = [];
  const claimed = claimedFieldsOf(resolve(filePath));
  // The dialect module is evidence: its `contracts` and `contractFields`
  // shape what this file registers, and a fixed module must re-scan. An
  // unknown load time poisons the stamp (always re-scan) rather than trust it.
  const module = dialectModuleOf(resolve(filePath));
  if (module) files.push({ path: module.path, mtimeMs: module.mtimeMs ?? -1 });
  const scope = { discovery, routes: routesForScan() };

  return withScanDependencies(files, packageFiles, () => {
    let dir = dirname(resolve(filePath));
    let packageJson: string | undefined;

    for (;;) {
      for (const tagDir of discovery.tagDirs) {
        const candidate = join(dir, tagDir);
        directories.push(candidate);
        if (existsSync(candidate)) {
          indexDirectory(
            candidate,
            tags,
            files,
            diagnostics,
            dottedTagFiles,
            scope,
          );
        }
      }

      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        packageJson = manifest;
        break;
      }

      const parent = dirname(dir);
      if (parent === dir || dir === options.stopAt) break;
      dir = parent;
    }

    if (packageJson) packageFiles.push(packageJson);
    indexMxConfig(
      dirname(resolve(filePath)),
      dir,
      packageJson,
      configFiles,
      tags,
      files,
      diagnostics,
      directories,
      dottedTagFiles,
      hostRestrictions,
      options.host,
      claimed,
      scope,
    );

    if (options.host !== undefined) applyHostFilter(tags, options.host);

    return {
      tags,
      customTags: buildCustomTags(tags, claimed),
      directories,
      packageFiles,
      configFiles,
      files,
      diagnostics: dottedTagFileDiagnostics(
        dottedTagFiles,
        options.targets,
        diagnostics,
      ),
      hostRestrictions,
      dottedTagFiles,
    };
  });
}

/** Whether a symlink entry resolves (following the link) to a directory. */
function isDirectorySymlink(
  dir: string,
  entry: { name: string; isSymbolicLink(): boolean },
): boolean {
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    // A broken symlink (target deleted, or a cycle `statSync` itself
    // refuses) is not a directory to descend into.
    return false;
  }
}

/**
 * Walks the directory tree under `root`, calling `visit(dir)` once per real
 * directory reached — never descending into `node_modules`, a dotdirectory,
 * or a nested package (a directory holding its own `package.json`, other
 * than `root` itself).
 *
 * A symlinked directory is followed (`Dirent.isDirectory()` is false for a
 * symlink regardless of its target, so `isDirectorySymlink` checks
 * explicitly). `visit(dir)` fires once for every *path* reached, named as
 * its parent named it — a `tags/` directory that happens to be a symlink is
 * still visited as `tags/`, never silently renamed to whatever its target is
 * called. What is guarded by `visited` (a set of `realpathSync` results) is
 * *descending further*: a path whose realpath was already read is visited
 * (so its own name is never missed) but not read again, which is what stops
 * a symlink cycle from recursing forever while still reporting every alias
 * that points at real content.
 *
 * Exported as a test seam, not public API: `discoverProjectTags` is the
 * function callers use. Splitting the walk out lets a test assert the
 * `visited` guard is what stops a symlink cycle from recursing forever,
 * which `discoverProjectTags`'s own return value cannot distinguish from
 * "happened to terminate some other way" (a cycle can also hit an OS-level
 * symlink or path-length limit before recursing very deep, which would make
 * an unguarded walk *appear* to terminate correctly on a short fixture
 * without the `visited` guard actually doing anything).
 */
export function walkProjectDirectories(
  root: string,
  visit: (dir: string) => void,
  visited: Set<string> = new Set(),
): void {
  const walk = (dir: string, isRoot: boolean): void => {
    if (!isRoot && existsSync(join(dir, "package.json"))) return;

    visit(dir);

    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => ({
          name: entry.name,
          // `Dirent.isDirectory()` is false for a symlink regardless of what
          // it points to; a symlinked `tags/` directory must still resolve
          // through `statSync` (following the link) to be recognized.
          isDirectory: entry.isDirectory() || isDirectorySymlink(dir, entry),
        }))
        .filter((entry) => entry.isDirectory);
    } catch {
      return;
    }

    for (const { name } of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (name.startsWith(".") || name === "node_modules") continue;
      walk(join(dir, name), false);
    }
  };
  walk(root, true);
}

export interface DiscoverProjectTagsOptions {
  /** Same meaning as `ScanOptions.targets`: the registered targets in hand. */
  targets: TargetLookup;
  /** Same meaning as `ScanOptions.host`: filters the returned tags by host. */
  host?: string | null;
}

/**
 * Enumerates every tag reachable inside a project root: every `tags/`
 * directory found by walking the tree downward from `projectDir`, plus the
 * root `package.json`'s `mx.tags` entries — the project-wide counterpart to
 * `scanCustomTags`'s single-file upward walk (spec §4).
 *
 * The walk never descends into `node_modules`, a dotdirectory, or a nested
 * package (a directory holding its own `package.json`, other than
 * `projectDir` itself) — a nested package's tags belong to *its* project, not
 * this one, the same boundary the upward walk stops at. A symlinked
 * directory is followed (`Dirent.isDirectory()` is false for a symlink
 * regardless of its target, so this is checked explicitly), guarded by a
 * visited-realpath set so a symlink cycle cannot recurse forever.
 *
 * Directories are visited in a stable, depth-then-name sorted order, so a
 * name two `tags/` directories both claim resolves to the shallower one
 * deterministically across runs — the same nearest-wins rule
 * `scanCustomTags`'s upward walk expresses by visiting nearer directories
 * first; here "nearer" means closer to the project root. `mx.tags` entries
 * are indexed last, exactly as in `scanCustomTags`, so a name a `tags/`
 * directory already claimed is left alone.
 */
export function discoverProjectTags(
  projectDir: string,
  options: DiscoverProjectTagsOptions,
): ScanResult {
  const root = resolve(projectDir);
  const tags = new Map<string, DiscoveredTag>();
  const directories: string[] = [];
  const packageFiles: string[] = [];
  const configFiles: string[] = [];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const diagnostics: ScanDiagnostic[] = [];
  const hostRestrictions: HostRestriction[] = [];
  const dottedTagFiles: DottedTagFile[] = [];

  return withScanDependencies(files, packageFiles, () => {
    const tagsDirs: string[] = [];
    walkProjectDirectories(root, (dir) => {
      if (basename(dir) === TAGS_DIR) tagsDirs.push(dir);
    });

    // Shallower directories first, so a name two `tags/` directories both
    // claim resolves to the one nearer the project root.
    tagsDirs.sort((left, right) => {
      const depthDiff =
        left.split(/[/\\]/).length - right.split(/[/\\]/).length;
      return depthDiff !== 0 ? depthDiff : left.localeCompare(right);
    });

    // MX's own discovery; a file a dialect with `tagDirs` claims is its.
    const scope = { routes: routesForScan() };
    for (const dir of tagsDirs) {
      directories.push(dir);
      indexDirectory(dir, tags, files, diagnostics, dottedTagFiles, scope);
    }

    const packageJson = join(root, "package.json");
    const hasManifest = existsSync(packageJson);
    if (hasManifest) packageFiles.push(packageJson);
    indexMxConfig(
      root,
      root,
      hasManifest ? packageJson : undefined,
      configFiles,
      tags,
      files,
      diagnostics,
      directories,
      dottedTagFiles,
      hostRestrictions,
      options.host,
      NO_CLAIM,
      scope,
    );

    if (options.host !== undefined) applyHostFilter(tags, options.host);

    return {
      tags,
      customTags: buildCustomTags(tags, NO_CLAIM),
      directories,
      packageFiles,
      configFiles,
      files,
      diagnostics: dottedTagFileDiagnostics(
        dottedTagFiles,
        options.targets,
        diagnostics,
      ),
      hostRestrictions,
      dottedTagFiles,
    };
  });
}
