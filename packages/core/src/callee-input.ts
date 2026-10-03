/**
 * The syntactic reader of a callee component's `Input` (decisions 106/107).
 *
 * A caller with attribute tags needs to know, per declared name, the
 * cardinality (`x?:` / `x:` / `x: …[]`), the shape (`as: "data"` renders
 * `{ ...attrs, content }`; `as: "renderable"` renders the body itself), and
 * whether the tag takes `attrs`/`params` — plus, one level down, the same
 * facts for `AttrTag` members of an `attrs` config (decision 107). Marko
 * reads this through a TS program; MX reads it *syntactically*, Vue
 * `defineProps<T>()` style: only type literals and aliases resolvable without
 * a program count, and anything that needs evaluation is a positioned error
 * ("declare this attribute tag's config literally").
 *
 * This module is the 1a half of phase 1: it resolves the callee file and
 * reads its `Input`, but nothing calls it yet — task 1b wires it into
 * `lowerComponent`, and until then a compile records no dependencies.
 *
 * Everything here is synchronous and cached by `path + mtimeMs + source`,
 * the same discipline as the template-metadata cache (`template-tag.ts`), so
 * an editor, a `tsc` run and a build read one callee identically. Every file
 * read is returned as a dependency so the Vite plugin can invalidate callers
 * when a callee's `Input` changes.
 */

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  resolve as resolvePath,
} from "node:path";
import { parse } from "@babel/parser";
import { CALLEE_INPUT_ERROR } from "./callee-input-error.ts";
import { type Ctx, isTranslateError, type Node } from "./core.ts";
import type { ComponentTarget } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import { hostModuleSegment } from "./scan.ts";
import type { TargetLookup } from "./target-descriptor.ts";
import { metadataForTemplate, touchAndEvict } from "./template-tag.ts";

const require = createRequire(import.meta.url);

/**
 * One declared attribute tag, read from the callee's `Input`.
 *
 * The shared contract between 1a (this reader) and 1b (the lowering rules):
 * 1b codes against these exact field names.
 */
export interface AttrTagDecl {
  cardinality: "optional" | "required" | "array";
  as: "data" | "renderable";
  hasAttrs: boolean;
  hasParams: boolean;
  /** `AttrTag` members of the `attrs` config, scanned recursively (107). */
  nested: Map<string, AttrTagDecl>;
  /** The `attrs` config is not a closed literal: unknown nested names allowed. */
  nestedOpen: boolean;
  /** Position in the callee's `Input` text, for messages. */
  span: FileSpan;
}

export interface FileSpan extends SourceSpan {
  file?: string;
}

/**
 * The callee's `Input`, one of four shapes.
 *
 * - `declared`: an `Input` was read and every attribute-tag property is a
 *   literal or resolvable alias. `open` is true when the `Input` has an
 *   unresolvable `extends` or an index signature — attribute tags the reader
 *   could not see may exist, so a caller-side unknown name is not an error.
 * - `none`: no `Input` to read (a JS callee, a `Props` export, a dynamic or
 *   local `<define>` target). The caller uses the syntactic fallback.
 * - `unresolved`: an explicit import whose specifier cannot be resolved.
 *   The caller uses the fallback and warns (decision 107) so an alias can't
 *   cause a silent shape flip.
 * - `invalid`: the `Input` declares an attribute tag whose config the reader
 *   cannot read literally. `errors` is keyed by property path — top-level
 *   names plain, nested attribute tags dotted (`"tabs.icon"`) — each with a
 *   callee span for the message.
 */
export type CalleeInput =
  | {
      kind: "declared";
      path: string;
      attrTags: Map<string, AttrTagDecl>;
      otherProps: Set<string>;
      open: boolean;
    }
  | { kind: "none"; path?: string }
  | { kind: "unresolved"; specifier: string }
  | {
      kind: "invalid";
      path: string;
      errors: Map<string, { message: string; span: FileSpan }>;
    };

/**
 * What the reader needs to know about the file doing the calling.
 *
 * `imports` maps a local binding to the import specifier as written (lower's
 * `ctx.imports` only holds names, so 1b builds this map from the `Import`
 * IR nodes); `discovered` maps a discovered template tag's call name to its
 * resolved absolute path. `ctx` is the lowering `Ctx`, used only for `.mx`
 * callees so the read rides the template-metadata compile/cache.
 */
export interface ResolveContext {
  /** The file making the call, for relative resolution and `require.resolve`. */
  importer: string;
  /**
   * The registered targets in hand (decisions 129 and 132). Required: the
   * reader asks it which packages export the `AttrTag` type and which
   * file-kind segments exist, and core holds no list to fall back on — a
   * caller that forgot it would accept a foreign `AttrTag` import and read a
   * host module file as a Marko template, both silently.
   */
  targets: TargetLookup;
  /** A tool-supplied resolver (tsconfig paths, vite alias), tried first. */
  resolveImport?: (specifier: string, importer: string) => string | undefined;
  /** Local binding -> import specifier, for explicit-import targets. */
  imports?: ReadonlyMap<string, string>;
  /** Discovered tag name -> resolved absolute template path. */
  discovered?: ReadonlyMap<string, string>;
  /** The lowering Ctx; required when the callee is a `.mx` template. */
  ctx?: Ctx;
}

export interface CalleeInputResult {
  input: CalleeInput;
  /** Every file read to produce `input`, this callee included. */
  dependencies: string[];
}

/**
 * A host-owned parser for a compound component extension.
 *
 * Core deliberately does not import every surrounding-language parser. The
 * host parses its module and hands the resulting Babel-compatible top-level
 * nodes back to the shared syntactic Input analyzer.
 */
export type CalleeInputReader = (request: {
  path: string;
  source: string;
  analyze(program: readonly unknown[]): CalleeInput;
}) => CalleeInput;

/**
 * The packages `AttrTag` may be imported from as the ambient type: this
 * package plus every registered target's own package, asked of the caller's
 * lookup rather than kept here (decisions 126 and 129): core names no
 * package. A third-party target that re-exports `AttrTag` from
 * `@mxlang/core` needs no descriptor entry; one that ships its own declares
 * it as its `packageName`, which `attrTagSources` reports. Targets of one
 * host may share a package, so the set is deduped.
 */
const attrTagSourceSets = new WeakMap<TargetLookup, ReadonlySet<string>>();

function attrTagSourcesOf(targets: TargetLookup): ReadonlySet<string> {
  let sources = attrTagSourceSets.get(targets);
  if (!sources) {
    sources = new Set(["@mxlang/core", ...targets.attrTagSources()]);
    attrTagSourceSets.set(targets, sources);
  }
  return sources;
}

function isMxAttrTagSource(specifier: string, targets: TargetLookup): boolean {
  return attrTagSourcesOf(targets).has(specifier);
}

const MAX_ALIAS_DEPTH = 4;
const MAX_CACHED_CALLEES = 256;
const calleeInputReaders = new Map<string, CalleeInputReader>();
const resolverIds = new WeakMap<
  NonNullable<ResolveContext["resolveImport"]>,
  number
>();
let nextResolverId = 1;

const calleeCache = new Map<
  string,
  {
    mtimeMs: number | undefined;
    source: string;
    result: CalleeInputResult;
    dependencySnapshots: Map<
      string,
      { mtimeMs: number | undefined; source: string }
    >;
  }
>();

/**
 * Source snapshots supplied by an editor while one synchronous compile runs.
 *
 * Callee `Input` resolution is intentionally synchronous, but an open editor
 * buffer can be newer than the file on disk. Tooling wraps compilation with
 * this helper so the syntactic reader observes the same text the user sees.
 * The previous map is restored in `finally`, which keeps nested compiles and
 * unrelated callers isolated.
 */
let activeSourceOverrides: ReadonlyMap<string, string> | undefined;

export function withCalleeInputSources<T>(
  sources: ReadonlyMap<string, string>,
  compile: () => T,
): T {
  const previous = activeSourceOverrides;
  activeSourceOverrides = sources;
  try {
    return compile();
  } finally {
    activeSourceOverrides = previous;
  }
}

function sourceSnapshot(path: string): {
  source: string;
  mtimeMs: number | undefined;
} {
  const source = activeSourceOverrides?.get(path);
  if (source !== undefined) return { source, mtimeMs: undefined };
  return {
    source: readFileSync(path, "utf8"),
    mtimeMs: statSync(path).mtimeMs,
  };
}

/** Clears the callee-input cache. Test-only: production reads are mtime-keyed. */
export function resetCalleeInputCache(): void {
  calleeCache.clear();
}

/** Registers the Input reader for one compound extension (longest match wins). */
export function registerCalleeInputReader(
  extension: string,
  reader: CalleeInputReader,
): void {
  calleeInputReaders.set(extension, reader);
  resetCalleeInputCache();
}

function cacheKey(
  path: string,
  resolver: ResolveContext["resolveImport"],
): string {
  if (!resolver) return `${path}\0default`;
  let id = resolverIds.get(resolver);
  if (id === undefined) {
    id = nextResolverId++;
    resolverIds.set(resolver, id);
  }
  return `${path}\0resolver:${id}`;
}

/**
 * Reads the callee component's `Input` for one call target.
 *
 * The result is cached by resolved path + mtime + source, bounded like the
 * template-metadata cache. Every file read — the callee itself and any
 * followed `import type` target — is recorded in `ctx.dependencies` when a
 * lowering `Ctx` is present, and returned either way.
 */
export function readCalleeInput(
  target: ComponentTarget,
  value: ResolveContext | Ctx,
): CalleeInputResult {
  const context: ResolveContext =
    "filename" in value
      ? {
          importer: value.filename,
          resolveImport: value.resolveImport,
          imports: value.importSpecifiers,
          ctx: value,
          targets: value.targets,
        }
      : value;
  if (
    "filename" in value &&
    target.kind === "name" &&
    target.name === value.exportName &&
    value.ownInput
  ) {
    return { input: value.ownInput, dependencies: [] };
  }
  const resolved = resolveTarget(target, context);
  if (resolved.kind !== "path") {
    const dependencies = resolved.candidates ?? [];
    recordDependencies(context.ctx, dependencies);
    return { input: resolved.input, dependencies };
  }

  let mtimeMs: number | undefined;
  let source: string;
  try {
    ({ mtimeMs, source } = sourceSnapshot(resolved.path));
  } catch {
    // Recorded as a dependency even though unread: an editor snapshot for
    // this exact path can arrive on a later compile (the caller retries with
    // `withCalleeInputSources` once it learns about the dependency), and a
    // watched-file event for it must still invalidate this caller.
    recordDependencies(context.ctx, [resolved.path]);
    return {
      input: { kind: "none", path: resolved.path },
      dependencies: [resolved.path],
    };
  }

  const key = cacheKey(resolved.path, context.resolveImport);
  const cached = calleeCache.get(key);
  if (
    cached &&
    cached.mtimeMs === mtimeMs &&
    cached.source === source &&
    snapshotsMatch(cached.dependencySnapshots)
  ) {
    recordDependencies(context.ctx, cached.result.dependencies);
    return cached.result;
  }

  let result: CalleeInputResult;
  let pending = false;
  let parsedSources = new Map<string, string>([[resolved.path, source]]);
  try {
    const analyzed = readInputAt(resolved.path, source, mtimeMs, context);
    pending = analyzed.pending === true;
    parsedSources = analyzed.parsedSources;
    result = { input: analyzed.input, dependencies: analyzed.dependencies };
  } catch (error) {
    const candidate = error as {
      message?: string;
      pos?: number;
      [CALLEE_INPUT_ERROR]?: CalleeInput;
    };
    if (candidate[CALLEE_INPUT_ERROR]?.kind === "invalid") {
      result = {
        input: candidate[CALLEE_INPUT_ERROR],
        dependencies: [resolved.path],
      };
    } else {
      const position = candidate.pos ?? 0;
      result = {
        input: {
          kind: "invalid",
          path: resolved.path,
          errors: new Map([
            [
              "<parse>",
              {
                message: candidate.message ?? String(error),
                span: {
                  file: resolved.path,
                  sourceStart: position,
                  sourceEnd: position,
                },
              },
            ],
          ]),
        },
        dependencies: [resolved.path],
      };
    }
  }
  if (!pending) {
    touchAndEvict(
      calleeCache,
      key,
      {
        mtimeMs,
        source,
        result,
        dependencySnapshots: snapshotDependencies(
          result.dependencies,
          parsedSources,
        ),
      },
      MAX_CACHED_CALLEES,
    );
  }
  recordDependencies(context.ctx, result.dependencies);
  return result;
}

function recordDependencies(
  ctx: Ctx | undefined,
  dependencies: string[],
): void {
  if (!ctx) return;
  ctx.dependencies ??= new Set();
  for (const dependency of dependencies) ctx.dependencies.add(dependency);
}

function snapshotDependencies(
  dependencies: string[],
  parsedSources: ReadonlyMap<string, string> = new Map(),
): Map<string, { mtimeMs: number | undefined; source: string }> {
  const snapshots = new Map<
    string,
    { mtimeMs: number | undefined; source: string }
  >();
  for (const dependency of dependencies) {
    try {
      const snapshot = sourceSnapshot(dependency);
      snapshots.set(dependency, {
        mtimeMs: snapshot.mtimeMs,
        source: parsedSources.get(dependency) ?? snapshot.source,
      });
    } catch {
      // A file that disappears after the read makes the next lookup miss.
      snapshots.set(dependency, { mtimeMs: undefined, source: "" });
    }
  }
  return snapshots;
}

function snapshotsMatch(
  snapshots: ReadonlyMap<
    string,
    { mtimeMs: number | undefined; source: string }
  >,
): boolean {
  for (const [path, snapshot] of snapshots) {
    try {
      const current = sourceSnapshot(path);
      if (
        current.mtimeMs !== snapshot.mtimeMs ||
        current.source !== snapshot.source
      ) {
        return false;
      }
    } catch {
      if (snapshot.mtimeMs !== undefined) return false;
    }
  }
  return true;
}

type ResolvedTarget =
  | { kind: "path"; path: string }
  | { kind: "input"; input: CalleeInput; candidates?: string[] };

function resolveTarget(
  target: ComponentTarget,
  context: ResolveContext,
): ResolvedTarget {
  // A `kind: "name"` target resolves by its own name. A dynamic target
  // resolves the same way only when `valueImportBinding` names the value
  // import decision 116 routed through this target — never for an author's
  // own `<${expr}/>`, which has no single known binding to resolve. A local
  // `<define>` has no file to read either way.
  const name =
    target.kind === "name"
      ? target.name
      : target.kind === "dynamic"
        ? target.valueImportBinding
        : undefined;
  if (!name) return { kind: "input", input: { kind: "none" } };

  if (target.kind === "name" && target.resolvedPath) {
    return { kind: "path", path: target.resolvedPath };
  }

  const discovered = context.discovered?.get(name);
  if (discovered) return { kind: "path", path: discovered };

  const specifier = context.imports?.get(name);
  if (!specifier) {
    // An unbound name is not a callee file this reader can open.
    return { kind: "input", input: { kind: "none" } };
  }
  const probes: string[] = [];
  const path = resolveSpecifier(specifier, context, context.importer, probes);
  if (path) return { kind: "path", path };
  // An unsaved editor buffer for this exact specifier resolves even though
  // nothing was written to disk yet: `resolveSpecifier`'s own probing
  // (`statSync`) cannot see it, but the candidate path it tried is still the
  // callee an open caller means, and recording it as `path` (not
  // `unresolved`) is what lets a later retry with the editor's snapshot see
  // the real declared shape instead of the untyped fallback.
  const openCandidate = probes.find((candidate) =>
    activeSourceOverrides?.has(candidate),
  );
  if (openCandidate) return { kind: "path", path: openCandidate };
  // Every probed candidate is recorded as a dependency (not just the
  // specifier text) so a compile retried once the editor snapshot map is
  // populated for one of them resolves through the branch above instead of
  // repeating this same "unresolved" result forever.
  return {
    kind: "input",
    input: { kind: "unresolved", specifier },
    candidates: probes,
  };
}

/**
 * Extension probes, in order (literal path first): `.mx`, then every compound
 * extension a host registered through {@link registerCalleeInputReader} (in
 * registration order), then the script extensions. A host module extension is
 * therefore only probed once its host package is loaded.
 */
function extensionProbes(): string[] {
  return [
    ...new Set([".mx", ...calleeInputReaders.keys()]),
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
  ];
}
const SCRIPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function probeFile(base: string, probes?: string[]): string | undefined {
  const extensions = extensionProbes();
  for (const candidate of [
    base,
    ...extensions.map((ext) => base + ext),
    ...["", ...extensions].map((ext) => resolvePath(base, `index${ext}`)),
  ]) {
    probes?.push(candidate);
    // An editor snapshot can be the only place an unsaved callee exists (a
    // brand-new file not yet flushed to disk), so a candidate the override
    // map knows about counts as found even when `statSync` cannot see it.
    if (activeSourceOverrides?.has(candidate)) return candidate;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing candidates are still dependencies so creating one invalidates.
    }
  }
  return undefined;
}

/**
 * Resolves one import specifier to an absolute file, synchronously.
 *
 * A tool's `resolveImport` is tried first (decision 107), then a relative or
 * absolute specifier is probed against the importing file's directory with
 * the MX extension list, then a bare specifier goes through
 * `require.resolve` from that directory, the way `scan.ts` resolves sidecar
 * imports. `importer` names the file the specifier was written in — a type
 * import inside a callee resolves against the callee's directory, not the
 * caller's.
 */
export function resolveSpecifier(
  specifier: string,
  context: ResolveContext,
  importer = context.importer,
  probes?: string[],
): string | undefined {
  if (context.resolveImport) {
    const aliased = context.resolveImport(specifier, importer);
    if (typeof aliased === "string") {
      const probed =
        isAbsolute(aliased) || aliased.startsWith(".")
          ? probeFile(
              isAbsolute(aliased)
                ? aliased
                : resolvePath(dirname(importer), aliased),
              probes,
            )
          : resolveSpecifier(
              aliased,
              { ...context, resolveImport: undefined },
              importer,
              probes,
            );
      if (probed) return probed;
    }
  }
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    isAbsolute(specifier)
  ) {
    return probeFile(resolvePath(dirname(importer), specifier), probes);
  }
  try {
    const resolved = require.resolve(specifier, { paths: [dirname(importer)] });
    if (statSync(resolved).isFile()) return resolved;
  } catch {
    // Extension probing below handles package subpaths such as `.mx` files.
  }
  const parts = specifier.split("/");
  const packageName = parts
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
  const subpath = parts.slice(specifier.startsWith("@") ? 2 : 1).join("/");
  if (!subpath) return undefined;
  try {
    const packageJson = require.resolve(`${packageName}/package.json`, {
      paths: [dirname(importer)],
    });
    return probeFile(resolvePath(dirname(packageJson), subpath), probes);
  } catch {
    return undefined;
  }
}

function readInputAt(
  path: string,
  source: string,
  mtimeMs: number | undefined,
  context: ResolveContext,
): CalleeInputResult & {
  pending?: boolean;
  parsedSources: Map<string, string>;
} {
  const parsedSources = new Map<string, string>([[path, source]]);
  const readerEntry = [...calleeInputReaders]
    .sort(([left], [right]) => right.length - left.length)
    .find(([extension]) => path.endsWith(extension));
  if (readerEntry) {
    const dependencies = [path];
    const analyzer = new InputAnalyzer(
      path,
      source,
      dependencies,
      context,
      parsedSources,
    );
    const input = readerEntry[1]({
      path,
      source,
      analyze(program) {
        analyzer.addNodes(program as Node[]);
        const declaration = analyzer.findInput(false);
        return declaration
          ? analyzer.analyzeInput(declaration)
          : { kind: "none", path };
      },
    });
    return { input, dependencies, parsedSources };
  }
  // A host module file (`card.ng.mx`, `card.solid.mx`, ...) is an ordinary
  // TypeScript module with a template region, not a Marko template. Until its
  // host package registers a reader, an absent schema is the safe fallback and
  // must never become an invalid Marko parse.
  if (hostModuleSegment(basename(path), context.targets) !== undefined) {
    return {
      input: { kind: "none", path },
      dependencies: [path],
      parsedSources,
    };
  }
  if (path.endsWith(".mx")) {
    if (!context.ctx) {
      // A `.mx` callee's Input is read through the template-metadata cache,
      // whose compile callback needs a real lowering Ctx. 1b always has one;
      // a bare-tool call without it gets a clear error rather than a guess.
      throw new Error(
        `@mxlang/core: reading the Input of a .mx callee (${path}) requires ResolveContext.ctx, the lowering Ctx the template-metadata cache compiles through`,
      );
    }
    const metadata = metadataForTemplate(context.ctx, {
      filename: path,
      source,
      mtimeMs,
    });
    const dependencies = [path];
    if (metadata.pending) {
      return {
        input: { kind: "none", path },
        dependencies,
        pending: true,
        parsedSources,
      };
    }
    const input = readInputFromText(
      path,
      source,
      metadata.inputCode,
      metadata.inputAuxCode,
      true,
      dependencies,
      context,
      parsedSources,
    );
    return { input, dependencies, parsedSources };
  }

  // Only known script modules are valid input to the Babel reader. Other
  // component formats remain untyped fallbacks unless a host registers a
  // reader for their extension above.
  if (!SCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    return {
      input: { kind: "none", path },
      dependencies: [path],
      parsedSources,
    };
  }

  const dependencies = [path];
  const input = readInputFromText(
    path,
    source,
    source,
    undefined,
    false,
    dependencies,
    context,
    parsedSources,
  );
  return { input, dependencies, parsedSources };
}

/**
 * Reads one `Input` from source text. `allowStaticInput` is true for `.mx`
 * callees, where a `<static>`-block `type Input`/`interface Input` counts
 * alongside an `export interface Input`; a `.ts`/`.tsx`/`.js(x)` callee only
 * exports count (decision 107 — a `Props` export is "no Input").
 *
 * `auxCode` is the `.mx` metadata's static-block and authored-import text:
 * the same-file alias and `import type` sources for the resolver.
 */
function readInputFromText(
  path: string,
  source: string,
  inputCode: string | undefined,
  auxCode: string | undefined,
  allowStaticInput: boolean,
  dependencies: string[],
  context: ResolveContext,
  parsedSources = new Map<string, string>([[path, source]]),
): CalleeInput {
  const analyzer = new InputAnalyzer(
    path,
    source,
    dependencies,
    context,
    parsedSources,
  );
  if (auxCode !== undefined) analyzer.addAux(auxCode);
  if (inputCode !== undefined) analyzer.addProgram(inputCode);

  const inputDecl = analyzer.findInput(allowStaticInput);
  if (!inputDecl) return { kind: "none", path };
  return analyzer.analyzeInput(inputDecl);
}

/** Reads the current compilation unit without entering its pending template
 * metadata entry. The lowerer supplies the already-sliced statement text. */
export function readOwnInput(
  ctx: Ctx,
  inputCode: string | undefined,
  auxCode: string | readonly string[] | undefined,
): CalleeInput {
  const auxUnits = typeof auxCode === "string" ? [auxCode] : (auxCode ?? []);
  if (
    inputCode === undefined &&
    !auxUnits.some((unit) =>
      /(?:^|\n)\s*(?:interface|type)\s+Input\b/.test(unit),
    )
  ) {
    return { kind: "none", path: ctx.filename };
  }
  const analyzer = new InputAnalyzer(
    ctx.filename,
    ctx.source,
    [],
    {
      importer: ctx.filename,
      resolveImport: ctx.resolveImport,
      imports: ctx.importSpecifiers,
      ctx,
      targets: ctx.targets,
    },
    new Map([[ctx.filename, ctx.source]]),
  );
  for (const unit of auxUnits) {
    if (!unit.trim()) continue;
    try {
      analyzer.addAux(unit);
    } catch {
      // The own-Input reader needs only declarations that parse independently;
      // unrelated static syntax must not make a valid Input unusable.
    }
  }
  if (inputCode) analyzer.addProgram(inputCode);
  const declaration = analyzer.findInput(true);
  return declaration
    ? analyzer.analyzeInput(declaration)
    : { kind: "none", path: ctx.filename };
}

/**
 * The per-read state: parsed declaration sources, the alias/import-type
 * tables, and the attribute-tag recognition rules.
 */
class InputAnalyzer {
  /** Combined top-level nodes of every parsed source for this read. */
  private readonly program: Node[] = [];
  /** Same-file type/interface declarations by name (latest wins). */
  private readonly declarations = new Map<string, Node>();
  /** Same-file value declarations, so a locally shadowed `AttrTag` is not ambient. */
  private readonly localValues = new Set<string>();
  /** `import type` bindings: local name -> specifier, imported name, and the file that declares the import. */
  private readonly typeImports = new Map<
    string,
    { specifier: string; imported: string; fromPath: string }
  >();
  /** Files already read, so a type-import cycle terminates. */
  private readonly readFiles = new Set<string>();
  private readonly reexportsSeen = new Set<string>();
  /** Non-mx `AttrTag` imports disqualify the identifier entirely. */
  private readonly attrTagDisallowed = new Set<string>();
  private readonly nodeFiles = new WeakMap<object, string>();
  private readonly nodeOffsets = new WeakMap<object, number>();

  constructor(
    private readonly path: string,
    private readonly source: string,
    private readonly dependencies: string[],
    private readonly context: ResolveContext,
    private readonly parsedSources: Map<string, string>,
  ) {}

  /** Parses one declaration source and merges its top-level nodes in. */
  addProgram(code: string): void {
    const offset = Math.max(0, this.source.indexOf(code));
    for (const node of parseDeclarationModule(code, this.path)) {
      this.addNode(node, this.path, offset);
    }
  }

  /** Merges already-parsed Babel-compatible top-level nodes. */
  addNodes(nodes: readonly Node[]): void {
    for (const node of nodes) this.addNode(node, this.path);
  }

  /**
   * Parses the `.mx` aux text (static blocks plus authored imports). A static
   * `Input` is declared there without `export`, which is exactly the form
   * `allowStaticInput` accepts.
   */
  addAux(code: string): void {
    this.addProgram(code);
  }

  private symbolKey(fromPath: string, name: string): string {
    return `${fromPath}::${name}`;
  }

  private annotate(node: unknown, fromPath: string, offset: number): void {
    if (!node || typeof node !== "object") return;
    this.nodeFiles.set(node, fromPath);
    this.nodeOffsets.set(node, offset);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) {
        for (const item of value) this.annotate(item, fromPath, offset);
      } else {
        this.annotate(value, fromPath, offset);
      }
    }
  }

  private addNode(node: Node, fromPath: string, offset = 0): void {
    this.annotate(node, fromPath, offset);
    this.program.push({ node, fromPath });
    switch (node.type) {
      case "ExportNamedDeclaration": {
        const declaration = node.declaration;
        if (
          declaration?.type === "TSInterfaceDeclaration" ||
          declaration?.type === "TSTypeAliasDeclaration"
        ) {
          this.declarations.set(
            this.symbolKey(fromPath, declaration.id.name as string),
            {
              node: declaration,
              fromPath,
            },
          );
          if (declaration.id.name === "AttrTag") {
            this.localValues.add(this.symbolKey(fromPath, "AttrTag"));
          }
        } else if (declaration?.type === "VariableDeclaration") {
          for (const item of declaration.declarations ?? []) {
            this.localValues.add(
              this.symbolKey(fromPath, item.id.name as string),
            );
          }
        } else if (declaration?.type === "FunctionDeclaration") {
          if (declaration.id?.name)
            this.localValues.add(this.symbolKey(fromPath, declaration.id.name));
        }
        break;
      }
      case "ImportDeclaration": {
        const specifier = node.source.value as string;
        const mxAttrTagSource = isMxAttrTagSource(
          specifier,
          this.context.targets,
        );
        for (const specifierNode of node.specifiers ?? []) {
          const local = specifierNode.local.name as string;
          const imported =
            specifierNode.type === "ImportDefaultSpecifier"
              ? "default"
              : (specifierNode.imported?.name ?? local);
          if (local === "AttrTag" && !mxAttrTagSource) {
            this.attrTagDisallowed.add(fromPath);
          }
          if (
            node.importKind === "type" ||
            specifierNode.importKind === "type"
          ) {
            this.typeImports.set(this.symbolKey(fromPath, local), {
              specifier,
              imported,
              fromPath,
            });
          } else if (local === "AttrTag") {
            // A runtime AttrTag import binds the name even from @mxlang — it
            // is recognised, just not as ambient.
            if (!mxAttrTagSource)
              this.localValues.add(this.symbolKey(fromPath, local));
          }
        }
        break;
      }
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
        this.declarations.set(
          this.symbolKey(fromPath, node.id.name as string),
          {
            node,
            fromPath,
          },
        );
        if (node.id.name === "AttrTag") {
          this.localValues.add(this.symbolKey(fromPath, "AttrTag"));
        }
        break;
      case "VariableDeclaration":
        for (const declaration of node.declarations ?? []) {
          this.localValues.add(
            this.symbolKey(fromPath, declaration.id.name as string),
          );
        }
        break;
      case "FunctionDeclaration":
      case "TSModuleDeclaration":
        if (node.id?.name)
          this.localValues.add(
            this.symbolKey(fromPath, node.id.name as string),
          );
        break;
    }
  }

  /** Finds the `Input` declaration: exported first, static-block when allowed. */
  findInput(allowStatic: boolean): Node | undefined {
    for (const entry of this.program) {
      const node = entry.node;
      if (
        (node.type === "ExportNamedDeclaration" &&
          node.declaration?.type === "TSInterfaceDeclaration") ||
        (node.type === "ExportNamedDeclaration" &&
          node.declaration?.type === "TSTypeAliasDeclaration")
      ) {
        if (node.declaration.id.name === "Input") {
          return { node: node.declaration, fromPath: entry.fromPath };
        }
      }
    }
    if (!allowStatic) return undefined;
    for (const entry of this.program) {
      const node = entry.node;
      if (
        (node.type === "TSInterfaceDeclaration" ||
          node.type === "TSTypeAliasDeclaration") &&
        node.id.name === "Input"
      ) {
        return { node, fromPath: entry.fromPath };
      }
    }
    return undefined;
  }

  /** Whether `AttrTag` may name an attribute-tag type in this callee. */
  private attrTagRecognized(fromPath: string): boolean {
    if (this.attrTagDisallowed.has(fromPath)) return false;
    // A local non-import declaration shadows the ambient type.
    if (
      this.localValues.has(this.symbolKey(fromPath, "AttrTag")) &&
      !this.typeImports.has(this.symbolKey(fromPath, "AttrTag"))
    ) {
      for (const entry of this.program) {
        const node = entry.node;
        if (
          entry.fromPath !== fromPath ||
          node.type !== "ImportDeclaration" ||
          !node.specifiers?.some((s: Node) => s.local.name === "AttrTag")
        ) {
          continue;
        }
        return true;
      }
      return false;
    }
    return true;
  }

  private spanOf(node: Node): FileSpan {
    const offset = this.nodeOffsets.get(node) ?? 0;
    return {
      file: this.nodeFiles.get(node) ?? this.path,
      sourceStart: offset + (node.start ?? 0),
      sourceEnd: offset + (node.end ?? 0),
    };
  }

  /**
   * Resolves a named type to its declaration across same-file declarations
   * and `import type`, depth ≤ 4 with a cycle guard (the brief's rules).
   */
  private resolveNamedType(
    name: string,
    fromPath: string,
    seen: Set<string>,
    depth: number,
  ): { node: Node; fromPath: string } | undefined {
    const key = `${fromPath}::${name}`;
    if (seen.has(key) || depth > MAX_ALIAS_DEPTH) return undefined;
    seen.add(key);

    const local = this.declarations.get(this.symbolKey(fromPath, name));
    if (local) return local;

    const typeImport = this.typeImports.get(this.symbolKey(fromPath, name));
    if (!typeImport) return undefined;
    const probes: string[] = [];
    const resolved = resolveSpecifier(
      typeImport.specifier,
      this.context,
      typeImport.fromPath,
      probes,
    );
    for (const probe of probes) {
      if (!this.dependencies.includes(probe)) this.dependencies.push(probe);
    }
    if (!resolved) return undefined;
    // The brief pins .ts and .mx targets for followed type imports; a
    // component's types never come from a runtime module.
    if (!/\.(?:tsx?|jsx?|mx)$/.test(resolved)) return undefined;

    let source: string;
    try {
      source = sourceSnapshot(resolved).source;
      this.parsedSources.set(resolved, source);
    } catch {
      return undefined;
    }
    this.readFiles.add(resolved);
    if (!this.dependencies.includes(resolved)) this.dependencies.push(resolved);

    const imported = this.importedDeclaration(
      resolved,
      source,
      typeImport.imported,
    );
    if (!imported) return undefined;
    // Merge the file's own aliases so a chain (A -> B -> C) keeps resolving.
    for (const node of imported.program)
      this.addNode(node, imported.declaration.fromPath);
    return imported.declaration;
  }

  /**
   * Reads one declaration by name from a followed type-import file. A `.mx`
   * file is Marko rather than a TS module, so it goes through the same
   * template-metadata compile/cache as a callee; the metadata exposes its
   * authored imports, exports, static declarations, and `Input` as TS text.
   */
  private importedDeclaration(
    resolved: string,
    source: string,
    imported: string,
  ):
    | { declaration: { node: Node; fromPath: string }; program: Node[] }
    | undefined {
    const reexportKey = `${resolved}::${imported}`;
    if (this.reexportsSeen.has(reexportKey)) return undefined;
    this.reexportsSeen.add(reexportKey);
    let code = source;
    if (resolved.endsWith(".mx")) {
      if (!this.context.ctx) return undefined;
      let mtimeMs: number | undefined;
      try {
        mtimeMs = sourceSnapshot(resolved).mtimeMs;
      } catch {
        return undefined;
      }
      const metadata = metadataForTemplate(this.context.ctx, {
        filename: resolved,
        source,
        mtimeMs,
      });
      code = [metadata.inputAuxCode, metadata.inputCode]
        .filter((part): part is string => part !== undefined)
        .join("\n");
    }
    if (code.trim() === "") return undefined;
    const program = parseDeclarationModule(code, resolved);
    for (const node of program) {
      const declaration =
        node.type === "ExportNamedDeclaration" ? node.declaration : node;
      if (
        declaration?.type === "TSInterfaceDeclaration" ||
        declaration?.type === "TSTypeAliasDeclaration"
      ) {
        if (declaration.id.name === imported) {
          return {
            declaration: { node: declaration, fromPath: resolved },
            program,
          };
        }
      }
    }
    for (const node of program) {
      if (node.type === "ExportNamedDeclaration" && node.source) {
        const match = (node.specifiers ?? []).find(
          (specifier: Node) =>
            (specifier.exported?.name ?? specifier.exported?.value) ===
            imported,
        );
        if (!match) continue;
        const importedName = match.local?.name ?? match.local?.value;
        const probes: string[] = [];
        const next = resolveSpecifier(
          node.source.value as string,
          this.context,
          resolved,
          probes,
        );
        for (const probe of probes) {
          if (!this.dependencies.includes(probe)) this.dependencies.push(probe);
        }
        if (!next) continue;
        const nextSource = sourceSnapshot(next).source;
        this.parsedSources.set(next, nextSource);
        this.readFiles.add(next);
        if (!this.dependencies.includes(next)) this.dependencies.push(next);
        const found = this.importedDeclaration(next, nextSource, importedName);
        if (found) return found;
      }
      if (node.type === "ExportAllDeclaration") {
        const probes: string[] = [];
        const next = resolveSpecifier(
          node.source.value as string,
          this.context,
          resolved,
          probes,
        );
        for (const probe of probes) {
          if (!this.dependencies.includes(probe)) this.dependencies.push(probe);
        }
        if (!next) continue;
        const nextSource = sourceSnapshot(next).source;
        this.parsedSources.set(next, nextSource);
        this.readFiles.add(next);
        if (!this.dependencies.includes(next)) this.dependencies.push(next);
        const found = this.importedDeclaration(next, nextSource, imported);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * Reads the `Input` declaration into the four-kind result. Members are
   * classified per property: an attribute-tag-typed property becomes an
   * `AttrTagDecl`, everything else an `otherProps` entry.
   */
  analyzeInput(inputDecl: { node: Node; fromPath: string }): CalleeInput {
    const errors = new Map<string, { message: string; span: FileSpan }>();
    const attrTags = new Map<string, AttrTagDecl>();
    const otherProps = new Set<string>();
    let open = false;

    const members = this.inputMembers(inputDecl.node, new Set(), 0, errors, "");
    for (const member of members) {
      if (member.kind === "index") {
        open = true;
        continue;
      }
      const analyzed = this.analyzeAttrTagType(
        member.type,
        new Set(),
        0,
        errors,
        member.name,
      );
      if (analyzed === undefined) {
        otherProps.add(member.name);
      } else if ("message" in analyzed) {
        errors.set(member.name, {
          message: analyzed.message,
          span: analyzed.span,
        });
      } else {
        // `x?:` marks the property, not the type. An array stays an array —
        // `x?: AttrTag[]` accepts any number, absent when not provided.
        if (member.optional && analyzed.cardinality === "required") {
          analyzed.cardinality = "optional";
        }
        attrTags.set(member.name, analyzed);
      }
    }

    if (errors.size > 0) return { kind: "invalid", path: this.path, errors };
    return { kind: "declared", path: this.path, attrTags, otherProps, open };
  }

  /**
   * Flattens an `Input`'s members, following `extends` clauses. An
   * unresolvable heritage identifier sets `open` (unknown attribute tags may
   * hide in the missing base) rather than erroring — the brief pins exactly
   * that rule.
   */
  private inputMembers(
    inputDecl: Node,
    seen: Set<string>,
    depth: number,
    errors: Map<string, { message: string; span: FileSpan }>,
    _path: string,
  ): Array<
    | {
        kind: "prop";
        name: string;
        type: Node;
        span: FileSpan;
        optional: boolean;
      }
    | { kind: "index"; span: FileSpan }
  > {
    const result: Array<
      | {
          kind: "prop";
          name: string;
          type: Node;
          span: FileSpan;
          optional: boolean;
        }
      | { kind: "index"; span: FileSpan }
    > = [];
    const declaration = inputDecl.node ?? inputDecl;
    const body =
      declaration.type === "TSInterfaceDeclaration"
        ? declaration.body?.body
        : declaration.typeAnnotation?.type === "TSTypeLiteral"
          ? declaration.typeAnnotation.members
          : undefined;

    if (body) {
      for (const member of body) {
        if (member.type === "TSIndexSignature") {
          result.push({ kind: "index", span: this.spanOf(member) });
          continue;
        }
        if (member.type !== "TSPropertySignature") continue;
        const name = propertyName(member.key);
        if (name === undefined) continue;
        result.push({
          kind: "prop",
          name,
          type: member.typeAnnotation?.typeAnnotation,
          span: this.spanOf(member),
          optional: member.optional === true,
        });
      }
    } else if (declaration.type === "TSTypeAliasDeclaration") {
      const alias = declaration.typeAnnotation;
      const parts = alias.type === "TSIntersectionType" ? alias.types : [alias];
      for (const part of parts) {
        if (part.type === "TSTypeLiteral") {
          result.push(
            ...this.inputMembers(
              { type: "TSTypeAliasDeclaration", typeAnnotation: part },
              new Set(seen),
              depth,
              errors,
              _path,
            ),
          );
          continue;
        }
        if (
          part.type === "TSTypeReference" &&
          part.typeName.type === "Identifier"
        ) {
          const partFromPath =
            this.nodeFiles.get(part) ?? inputDecl.fromPath ?? this.path;
          const base = this.resolveNamedType(
            part.typeName.name,
            partFromPath,
            new Set(seen),
            depth + 1,
          );
          if (base) {
            result.push(
              ...this.inputMembers(base, seen, depth + 1, errors, _path),
            );
            continue;
          }
          // Resolution failed -- either the name genuinely does not exist
          // (an ordinary open member, as before), or it does but the alias
          // chain behind it is deeper than `MAX_ALIAS_DEPTH`. A deeper
          // reader would have found `AttrTag` config members it silently
          // dropped, so this reports the same "declare literally" error the
          // property-alias path (`analyzeAttrTagType`) already gives that
          // situation, instead of quietly leaving the member open.
          if (
            this.namedTypeEventuallyContainsAttrTag(
              part.typeName.name,
              partFromPath,
              new Set(),
            )
          ) {
            errors.set("<input>", {
              message: "declare this attribute tag's config literally",
              span: this.spanOf(part),
            });
          }
        }
        if (containsAttrTag(part)) {
          errors.set("<input>", {
            message: "declare this attribute tag's config literally",
            span: this.spanOf(part),
          });
        }
        result.push({ kind: "index", span: this.spanOf(part) });
      }
      return result;
    }

    // `interface Input extends Base` — resolvable bases are flattened in,
    // unresolvable ones make the Input open (unless the unreached chain
    // behind an unresolvable-but-real base would have contained an
    // `AttrTag`, in which case it is a positioned error instead -- same
    // rule as the intersection-part branch above). The flag travels through
    // the shared `errors`-free return: encode it as an index member the
    // caller treats as `open`.
    if (declaration.extends) {
      for (const heritage of declaration.extends) {
        const baseName =
          heritage.expression?.type === "Identifier"
            ? heritage.expression.name
            : heritage.id?.type === "Identifier"
              ? heritage.id.name
              : undefined;
        if (!baseName) {
          result.push({ kind: "index", span: this.spanOf(heritage) });
          continue;
        }
        const heritageFromPath =
          this.nodeFiles.get(heritage) ?? inputDecl.fromPath ?? this.path;
        const base = this.resolveNamedType(
          baseName,
          heritageFromPath,
          seen,
          depth + 1,
        );
        if (!base) {
          if (
            this.namedTypeEventuallyContainsAttrTag(
              baseName,
              heritageFromPath,
              new Set(),
            )
          ) {
            errors.set("<input>", {
              message: "declare this attribute tag's config literally",
              span: this.spanOf(heritage),
            });
          }
          result.push({ kind: "index", span: this.spanOf(heritage) });
          continue;
        }
        result.push(...this.inputMembers(base, seen, depth + 1, errors, _path));
      }
    }
    return result;
  }

  /**
   * Classifies one property's type. Returns a full `AttrTagDecl` when the
   * type is an attribute-tag form, `{ message }` when it is an attribute-tag
   * form whose config cannot be read literally, or undefined when the
   * property is not an attribute tag at all.
   */
  private analyzeAttrTagType(
    type: Node,
    seen: Set<string>,
    depth: number,
    errors: Map<string, { message: string; span: FileSpan }>,
    propPath: string,
  ): AttrTagDecl | { message: string; span: FileSpan } | undefined {
    if (!type) return undefined;
    let node = type;
    let cardinality: "optional" | "required" | "array" = "required";
    let optionalUnion = false;

    if (node.type === "TSOptionalType") node = node.typeAnnotation;
    if (node.type === "TSUnionType") {
      const concrete = node.types.filter(
        (part: Node) => part.type !== "TSUndefinedKeyword",
      );
      if (concrete.length === 1 && concrete.length !== node.types.length) {
        node = concrete[0];
        optionalUnion = true;
      } else if (containsAttrTag(node)) {
        return {
          message: "declare this attribute tag's config literally",
          span: this.spanOf(node),
        };
      } else {
        return undefined;
      }
    }

    const unwrap = (n: Node): { node: Node; array: boolean } => {
      if (n.type === "TSParenthesizedType") return unwrap(n.typeAnnotation);
      if (n.type === "TSTypeOperator" && n.operator === "readonly") {
        return unwrap(n.typeAnnotation);
      }
      if (n.type === "TSArrayType") {
        const inner = unwrap(n.elementType);
        return { node: inner.node, array: true };
      }
      if (
        n.type === "TSTypeReference" &&
        (n.typeName.name === "Array" || n.typeName.name === "ReadonlyArray") &&
        n.typeParameters?.params?.length === 1
      ) {
        const inner = unwrap(n.typeParameters.params[0]);
        return { node: inner.node, array: true };
      }
      return { node: n, array: false };
    };

    let unwrapped = unwrap(node);
    if (unwrapped.array) cardinality = "array";
    node = unwrapped.node;

    // Alias chains: an identifier whose declaration resolves to an
    // attribute-tag form counts, same as the literal.
    let propertyDepth = depth;
    while (
      node.type === "TSTypeReference" &&
      node.typeName.type === "Identifier" &&
      node.typeName.name !== "AttrTag"
    ) {
      propertyDepth++;
      const resolved = this.resolveNamedType(
        node.typeName.name,
        this.nodeFiles.get(node) ?? this.path,
        seen,
        propertyDepth,
      );
      if (!resolved) {
        return this.namedTypeEventuallyContainsAttrTag(
          node.typeName.name,
          this.nodeFiles.get(node) ?? this.path,
          new Set(),
        )
          ? {
              message: "declare this attribute tag's config literally",
              span: this.spanOf(type),
            }
          : undefined; // An unrelated unresolvable reference is an ordinary prop.
      }
      const aliasDecl = resolved.node;
      const aliasType =
        aliasDecl.type === "TSTypeAliasDeclaration"
          ? aliasDecl.typeAnnotation
          : aliasDecl.body?.type === "TSTypeLiteral"
            ? aliasDecl.body
            : undefined;
      if (!aliasType) return undefined;
      unwrapped = unwrap(aliasType);
      if (unwrapped.array) cardinality = "array";
      node = unwrapped.node;
    }

    if (
      node.type !== "TSTypeReference" ||
      node.typeName.type !== "Identifier" ||
      node.typeName.name !== "AttrTag"
    ) {
      if (containsAttrTag(node)) {
        return {
          message: "declare this attribute tag's config literally",
          span: this.spanOf(node),
        };
      }
      return undefined;
    }
    if (!this.attrTagRecognized(this.nodeFiles.get(node) ?? this.path))
      return undefined;

    const config = node.typeParameters?.params?.[0];
    const decl: AttrTagDecl = {
      cardinality:
        optionalUnion && cardinality === "required" ? "optional" : cardinality,
      as: "data",
      hasAttrs: false,
      hasParams: false,
      nested: new Map(),
      nestedOpen: false,
      span: this.spanOf(node),
    };
    if (!config) return decl;

    let configLiteral = config;
    let configDepth = 0;
    while (
      configLiteral.type === "TSTypeReference" &&
      configLiteral.typeName.type === "Identifier"
    ) {
      const resolved = this.resolveNamedType(
        configLiteral.typeName.name,
        this.nodeFiles.get(configLiteral) ?? this.path,
        seen,
        configDepth + 1,
      );
      const aliasDecl = resolved?.node;
      const aliasType =
        aliasDecl?.type === "TSTypeAliasDeclaration"
          ? aliasDecl.typeAnnotation
          : aliasDecl?.type === "TSInterfaceDeclaration"
            ? { type: "TSTypeLiteral", members: aliasDecl.body.body }
            : undefined;
      if (!aliasType) break;
      configLiteral = aliasType;
      configDepth++;
    }
    if (configLiteral.type !== "TSTypeLiteral") {
      return {
        message: "declare this attribute tag's config literally",
        span: this.spanOf(node),
      };
    }

    for (const member of configLiteral.members ?? []) {
      if (member.type === "TSIndexSignature") {
        decl.nestedOpen = true;
        continue;
      }
      if (member.type !== "TSPropertySignature") continue;
      const name = propertyName(member.key);
      if (name === undefined) continue;
      const memberType = member.typeAnnotation?.typeAnnotation;
      switch (name) {
        case "as": {
          if (
            memberType?.type === "TSLiteralType" &&
            memberType.literal.type === "StringLiteral" &&
            (memberType.literal.value === "data" ||
              memberType.literal.value === "renderable")
          ) {
            decl.as = memberType.literal.value;
          } else {
            return {
              message: "declare this attribute tag's config literally",
              span: this.spanOf(node),
            };
          }
          break;
        }
        case "attrs": {
          decl.hasAttrs = true;
          this.scanAttrs(memberType, decl, new Set(seen), 0, errors, propPath);
          break;
        }
        case "params": {
          decl.hasParams = true;
          const paramsType =
            memberType?.type === "TSTypeOperator" &&
            memberType.operator === "readonly"
              ? memberType.typeAnnotation
              : memberType;
          if (paramsType?.type !== "TSTupleType") {
            return {
              message: "attribute tag params must be a tuple type",
              span: this.spanOf(node),
            };
          }
          break;
        }
        default:
          break;
      }
    }

    if (decl.as === "renderable" && decl.hasAttrs) {
      return {
        message:
          'renderable attribute tags can\'t take attributes; declare as: "data"',
        span: this.spanOf(node),
      };
    }
    return decl;
  }

  /**
   * Detects an AttrTag hidden beyond the supported alias/base-following
   * depth (`MAX_ALIAS_DEPTH`), for a *named type* reference (a property's
   * alias, an intersection part, or an `extends` base name) — unbounded by
   * that depth cap on purpose: it exists only to tell a genuinely
   * unresolvable name (no such type; stays a silent open member/prop, as
   * before) apart from a real chain that a deeper reader would have found an
   * `AttrTag` behind (now a positioned error, never a silent degrade). Both
   * a type alias and an interface declaration are followed, since an
   * `extends` base can be either.
   */
  private namedTypeEventuallyContainsAttrTag(
    name: string,
    fromPath: string,
    seen: Set<string>,
  ): boolean {
    const key = `${fromPath}::${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const resolved =
      this.declarations.get(key) ??
      this.resolveNamedType(name, fromPath, new Set(), 0);
    const declaration = resolved?.node;
    if (!declaration) return false;
    const declFromPath = resolved?.fromPath ?? fromPath;

    if (declaration.type === "TSInterfaceDeclaration") {
      if (containsAttrTag(declaration.body)) return true;
      return (declaration.extends ?? []).some((heritage: Node) => {
        const baseName =
          heritage.expression?.type === "Identifier"
            ? heritage.expression.name
            : heritage.id?.type === "Identifier"
              ? heritage.id.name
              : undefined;
        return (
          baseName !== undefined &&
          this.namedTypeEventuallyContainsAttrTag(baseName, declFromPath, seen)
        );
      });
    }

    const type =
      declaration.type === "TSTypeAliasDeclaration"
        ? declaration.typeAnnotation
        : undefined;
    if (!type) return false;
    if (containsAttrTag(type)) return true;
    if (
      type.type === "TSTypeReference" &&
      type.typeName.type === "Identifier"
    ) {
      return this.namedTypeEventuallyContainsAttrTag(
        type.typeName.name,
        declFromPath,
        seen,
      );
    }
    if (type.type === "TSIntersectionType") {
      return type.types.some(
        (part: Node) =>
          containsAttrTag(part) ||
          (part.type === "TSTypeReference" &&
            part.typeName.type === "Identifier" &&
            this.namedTypeEventuallyContainsAttrTag(
              part.typeName.name,
              declFromPath,
              seen,
            )),
      );
    }
    return false;
  }

  /**
   * Scans an `attrs` config recursively (decision 107): `AttrTag` members
   * become `nested` declarations, non-`AttrTag` members are plain attrs and
   * are not interpreted, and a non-closed `attrs` type sets `nestedOpen`.
   */
  private scanAttrs(
    attrsType: Node,
    decl: AttrTagDecl,
    seen: Set<string>,
    depth: number,
    errors: Map<string, { message: string; span: FileSpan }>,
    propPath: string,
  ): void {
    let literal = attrsType;
    while (
      literal?.type === "TSTypeReference" &&
      literal.typeName.type === "Identifier"
    ) {
      const literalFromPath = this.nodeFiles.get(literal) ?? this.path;
      const resolved = this.resolveNamedType(
        literal.typeName.name,
        literalFromPath,
        seen,
        depth + 1,
      );
      const aliasDecl = resolved?.node;
      const aliasType =
        aliasDecl?.type === "TSTypeAliasDeclaration"
          ? aliasDecl.typeAnnotation
          : aliasDecl?.type === "TSInterfaceDeclaration"
            ? { type: "TSTypeLiteral", members: aliasDecl.body.body }
            : undefined;
      if (!aliasType) {
        // Resolution failed outright -- either the name genuinely does not
        // exist (an ordinary open `attrs` config, as before), or a real
        // chain behind it is deeper than `MAX_ALIAS_DEPTH` and hides a
        // nested `AttrTag` a deeper reader would have found. Same rule as
        // the property-alias and extends/intersection paths above: report
        // it rather than silently opening the config.
        if (
          this.namedTypeEventuallyContainsAttrTag(
            literal.typeName.name,
            literalFromPath,
            new Set(),
          )
        ) {
          errors.set(propPath, {
            message: "declare this attribute tag's config literally",
            span: this.spanOf(literal),
          });
        }
        decl.nestedOpen = true;
        return;
      }
      literal = aliasType;
      depth++;
    }
    if (literal?.type !== "TSTypeLiteral") {
      // `attrs` is not a closed literal (a mapped type, an unresolvable
      // alias, `object`): nested attribute tags may exist that this reader
      // cannot name.
      decl.nestedOpen = true;
      return;
    }
    for (const member of literal.members ?? []) {
      if (member.type === "TSIndexSignature") {
        decl.nestedOpen = true;
        continue;
      }
      if (member.type !== "TSPropertySignature") continue;
      const name = propertyName(member.key);
      if (name === undefined) continue;
      const nested = this.analyzeAttrTagType(
        member.typeAnnotation?.typeAnnotation,
        new Set(seen),
        0,
        errors,
        `${propPath}.${name}`,
      );
      if (nested === undefined) continue; // A plain attr.
      if ("message" in nested) {
        errors.set(`${propPath}.${name}`, {
          message: nested.message,
          span: nested.span,
        });
        continue;
      }
      // Same rule as the top level: `?` marks the member; an array stays an
      // array.
      if (member.optional && nested.cardinality === "required") {
        nested.cardinality = "optional";
      }
      decl.nested.set(name, nested);
    }
  }
}

function propertyName(key: Node | undefined): string | undefined {
  if (!key) return undefined;
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  return undefined;
}

function containsAttrTag(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  const typeName = node.typeName as
    | { type?: string; name?: string }
    | undefined;
  if (
    node.type === "TSTypeReference" &&
    typeName?.type === "Identifier" &&
    typeName.name === "AttrTag"
  ) {
    return true;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      if (child.some(containsAttrTag)) return true;
    } else if (containsAttrTag(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Parses source text into top-level module nodes with Babel's real TypeScript
 * and JSX parser. The complete module is always parsed: declarations are not
 * scraped out of TSX text, so offsets and syntax are the callee's real AST.
 */
function parseDeclarationModule(code: string, _file: string): Node[] {
  return parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  }).program.body as Node[];
}
