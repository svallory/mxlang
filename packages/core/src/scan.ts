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

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BUILTIN_CUSTOM_TAGS } from "./builtin-tags.ts";
import { isTranslateError, TranslateError } from "./core.ts";
import {
  type ContractMap,
  type CustomTag,
  type CustomTagParseOptions,
  rejectUnknownDeclarationKeys,
  rejectUnreachableHooks,
} from "./custom-tags.ts";
import {
  clearPackageJsonCache,
  type PackageJsonParseError,
  positionOfOffset,
  readPackageJsonCached,
} from "./package-json.ts";
import { dropOwnParserPosition } from "./parse-error-position.ts";
import type { TargetLookup } from "./target-descriptor.ts";
import type { TemplateTag } from "./template-tag.ts";

const require = createRequire(import.meta.url);

/** The directory a tag file lives in, relative to its package. */
const TAGS_DIR = "tags";

/** A sidecar: the hooks half of a custom tag. */
const SIDECAR_SUFFIX = ".tag.ts";

/** A template tag (L1). Expansion itself is P3; discovery is here. */
const TEMPLATE_SUFFIX = ".mx";

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

/**
 * What a tag file's basename may be, and therefore what a call name may be.
 *
 * The rule: a letter, digit or underscore to start, then letters, digits,
 * underscores, hyphens and dots. It is Marko's own tag-name vocabulary, minus
 * the shapes that break the compiler rather than merely looking odd.
 *
 * This is a guard with teeth, not tidiness. `tags/.mx` has an empty basename,
 * and an empty tag name makes `@marko/compiler` throw `Error while applying
 * option of "<>". Cause: "tag.name" is required` — which fails *every* file in
 * the package, not just the one that would have called it. Dotfiles are the
 * same class from the other side: `.DS_Store.mx` would register a tag named
 * `.DS_Store`, and a `tags/` directory is an ordinary directory that collects
 * ordinary junk.
 *
 * Case is preserved: `tags/Icon.tag.ts` is `<Icon>`, not `<icon>`. A tag name
 * is the filename, and the filename is the author's.
 */
const TAG_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

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
}

/**
 * The scan has no position to report against the *calling* file, since a
 * broken sidecar is a fact about the sidecar. Diagnostics therefore name the
 * offending file and carry that file's own position, which is what lets the
 * language server point an author at the real problem.
 */
function failIn(file: string, message: string, line = 1, column = 0): never {
  throw new TranslateError(`${file}: ${message}`, line, column);
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
  const text = readPackageJsonCached(packageFile)?.text ?? "";
  const tokens = [
    ...text.matchAll(
      /"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    ),
  ];
  let cursor = 0;
  let offset = 0;
  const value = (path: string[]): void => {
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
        if (path.length === 1 && path[0] === "mx" && name === "contracts")
          offset = key.index;
        cursor++; // colon
        value([...path, name]);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    } else if (start[0] === "[") {
      while (tokens[cursor] && tokens[cursor]?.[0] !== "]") {
        value([...path, "[]"]);
        if (tokens[cursor]?.[0] === ",") cursor++;
      }
      cursor++;
    }
  };
  value([]);
  return positionOfOffset(text, offset);
}

/** Contracts failures address the actual source file, not the calling page. */
function failContracts(
  file: string,
  message: string,
  line = 1,
  column = 0,
): never {
  const positioned = message.startsWith(`${file}: `)
    ? message
    : `${file}: ${message}`;
  throw new TranslateError(positioned, line, column, file);
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
 * The file is parsed with the Babel instance `@marko/compiler` already
 * bundles — the same one `fragment.ts` uses — rather than a second copy of
 * `@babel/parser` added as a dependency.
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
  const babel = require("@marko/compiler/internal/babel");
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

function loadDefaultExport(
  file: string,
  what: "sidecar" | "contracts module",
): Record<string, unknown> {
  let module: { default?: unknown } | undefined;
  try {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    module = require(file) as { default?: unknown };
  } catch (cause) {
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
      `${what} must \`export default\` ${what === "sidecar" ? "a CustomTag object" : "a plain ContractMap object"}`,
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
function lazyTag(tag: DiscoveredTag): CustomTag {
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
    loaded ??= loadSidecar(sidecar);
    return loaded;
  };

  for (const key of [
    "attributes",
    "attributeTags",
    "children",
    "parents",
  ] as const) {
    Object.defineProperty(definition, key, {
      enumerable: true,
      configurable: true,
      get: () => load()[key],
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

  // Sorted so a directory holding both `x.mx` and `x.tag.ts` indexes them in
  // a fixed order regardless of the filesystem's own enumeration.
  for (const entry of entries.sort()) {
    // A dotfile is never a tag. `.DS_Store.mx` would otherwise register as
    // `<.DS_Store>` and `tags/.mx` as a tag with no name at all; see
    // `TAG_NAME_RE`.
    if (entry.startsWith(".")) continue;

    const isSidecar = entry.endsWith(SIDECAR_SUFFIX);

    if (rejectUncallableTagFile(dir, entry, diagnostics, dottedTagFiles))
      continue;
    const isTemplate = entry.endsWith(TEMPLATE_SUFFIX);

    if (!isSidecar && !isTemplate) continue;

    const bare = isSidecar
      ? basename(entry, SIDECAR_SUFFIX)
      : basename(entry, TEMPLATE_SUFFIX);
    if (!TAG_NAME_RE.test(bare)) {
      failIn(
        join(dir, entry),
        `\`${bare}\` is not a usable tag name; a tag file's name must start with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots`,
      );
    }
    const path = join(dir, entry);
    const name = `${options.prefix ?? ""}${bare}`;

    // A core-owned tag (`<try>`) cannot be shadowed: `rejectShadowedRegistration`
    // refuses the *whole* map when one appears in it, so handing this name
    // onward would break every file in the package — including files that
    // never call the tag — over one misnamed file. Reported and skipped
    // instead, the same way a misconfigured `mx.tags` entry is: the author is
    // told, and everything else keeps working.
    if (Object.hasOwn(BUILTIN_CUSTOM_TAGS, name)) {
      diagnostics.push({
        file: path,
        message: `\`<${name}>\` is a core-owned custom tag and cannot be redefined by a tag file; rename this file`,
        line: 1,
        column: 0,
      });
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

    files.push({ path, mtimeMs });
    const tag: DiscoveredTag = existing ?? {
      name,
      sourceDir: dir,
      hosts: options.hosts,
    };
    if (isSidecar) {
      tag.sidecar = path;
      // The sidecar's own declaration overrides the directory default, which
      // is what "directory-level defaults a sidecar may override" means.
      const declared = readParseOptions(readFileSync(path, "utf8"), path);
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
): Record<string, CustomTag> {
  const customTags: Record<string, CustomTag> = Object.create(null);
  for (const [name, tag] of tags)
    customTags[name] = tag.contract ?? lazyTag(tag);
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
  tags: Map<string, DiscoveredTag>,
  files: Array<{ path: string; mtimeMs: number }>,
  diagnostics: ScanDiagnostic[],
  directories: string[],
  dottedTagFiles: DottedTagFile[],
  hostRestrictions: HostRestriction[],
  host: ScanOptions["host"],
): void {
  const manifest = readManifest(packageJson, diagnostics);
  const entries = normalizeMxTags(manifest?.mx?.tags, packageDir, packageJson);
  for (const entry of entries) {
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
      prefix: entry.prefix,
      parseOptions: entry.parseOptions,
      hosts: entry.hosts,
    });
  }
  indexMxContractsEntries(
    manifest?.mx?.contracts,
    packageDir,
    packageJson,
    tags,
    files,
    diagnostics,
    hostRestrictions,
    host,
  );
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
        if (Object.hasOwn(BUILTIN_CUSTOM_TAGS, name)) {
          diagnostics.push({
            file,
            line: 1,
            column: 0,
            message: `\`<${name}>\` is a core-owned custom tag and cannot be redefined by \`mx.contracts\`; remove this key`,
          });
          continue;
        }
        if (!isRecord(definition) || !plain(definition))
          failContracts(file, `\`<${name}>\` must be a plain CustomTag object`);
        for (const key of Object.getOwnPropertyNames(definition)) {
          if (
            ![
              "parseOptions",
              "attributes",
              "attributeTags",
              "children",
              "parents",
              "analyze",
            ].includes(key)
          ) {
            failContracts(
              file,
              `\`<${name}>\`: \`${key}\` is not allowed in \`mx.contracts\`; use a tag sidecar for hooks other than \`analyze\` and for templates`,
            );
          }
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
      rejectUnknownDeclarationKeys(contracts);
      rejectUnreachableHooks(contracts);
    } catch (cause) {
      failContracts(
        file,
        cause instanceof Error ? cause.message : String(cause),
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
  const tags = new Map<string, DiscoveredTag>();
  const directories: string[] = [];
  const packageFiles: string[] = [];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const diagnostics: ScanDiagnostic[] = [];
  const hostRestrictions: HostRestriction[] = [];
  const dottedTagFiles: DottedTagFile[] = [];

  return withScanDependencies(files, packageFiles, () => {
    let dir = dirname(resolve(filePath));
    let packageDir: string | undefined;
    let packageJson: string | undefined;

    for (;;) {
      const candidate = join(dir, TAGS_DIR);
      directories.push(candidate);
      if (existsSync(candidate)) {
        indexDirectory(candidate, tags, files, diagnostics, dottedTagFiles);
      }

      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        packageDir = dir;
        packageJson = manifest;
        break;
      }

      const parent = dirname(dir);
      if (parent === dir || dir === options.stopAt) break;
      dir = parent;
    }

    if (packageDir && packageJson) {
      packageFiles.push(packageJson);
      indexMxTagsEntries(
        packageDir,
        packageJson,
        tags,
        files,
        diagnostics,
        directories,
        dottedTagFiles,
        hostRestrictions,
        options.host,
      );
    }

    if (options.host !== undefined) applyHostFilter(tags, options.host);

    return {
      tags,
      customTags: buildCustomTags(tags),
      directories,
      packageFiles,
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

    for (const dir of tagsDirs) {
      directories.push(dir);
      indexDirectory(dir, tags, files, diagnostics, dottedTagFiles);
    }

    const packageJson = join(root, "package.json");
    if (existsSync(packageJson)) {
      packageFiles.push(packageJson);
      indexMxTagsEntries(
        root,
        packageJson,
        tags,
        files,
        diagnostics,
        directories,
        dottedTagFiles,
        hostRestrictions,
        options.host,
      );
    }

    if (options.host !== undefined) applyHostFilter(tags, options.host);

    return {
      tags,
      customTags: buildCustomTags(tags),
      directories,
      packageFiles,
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
