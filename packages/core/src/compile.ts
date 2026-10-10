/**
 * The whole-file front door (decision 70): a Marko template in, an emitted
 * module out, with the host's policy deciding everything host-specific.
 *
 * Named `compileSource`, not `compileFile`: it takes source text, and a host
 * is free to keep its own disk-reading `compileFile(filename)` as its public
 * API (`@mxlang/target-html` does) without two different signatures sharing one
 * name across the two packages.
 *
 * This is the seam ADR 0001 names: `@marko/compiler` selects a translator by
 * `config.translator`, and a translator supplying only `translate` (plus its
 * taglibs) injects no runtime at all. The code used to live in
 * `@mxlang/target-html`'s `index.ts`; it is core's because the seam is the
 * same for every host — only the taglib list, the policies and any post-pass
 * over the emitted code differ, and those arrive as arguments.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type AtomFacts, emptyAtomFacts } from "./atom-contracts.ts";
import { coreBabel } from "./babel.ts";
import { rejectShadowedRegistration } from "./builtin-tags.ts";
import { annotateCloseTagOpener } from "./close-tag-opener.ts";
import { type ClaimedFields, claimedFields } from "./contract-fields.ts";
import {
  assertPositioned,
  type Ctx,
  isTranslateError,
  type MxWarning,
  type Node,
  newCtx,
  type TranslateError,
} from "./core.ts";
import {
  CORE_TAGLIB_ID,
  STATEMENT_TAGLIB,
  STATEMENT_TAGLIB_ID,
} from "./core-taglib.ts";
import {
  type CustomTag,
  customTagTaglib,
  rejectUnknownDeclarationKeys,
  rejectUnreachableHooks,
  rejectWildcardReferences,
} from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Ir } from "./ir.ts";
import { lower } from "./lower.ts";
import {
  compileErrorOf,
  parseMx,
  registerDocument,
  stripMxTypes,
} from "./mx-parse.ts";
import { hintParseError } from "./parse-error-hints.ts";
import { sugarAfterDefaultError, tagParamError } from "./stock-parser.ts";
import {
  explicitSyntaxOf,
  resolveSyntaxOf,
  type SyntaxModule,
  type SyntaxTable,
  tableParseError,
} from "./syntax-table.ts";
import { type NativeTags, type TagTable, tagTable } from "./tag-table.ts";
import type { TargetLookup } from "./target-descriptor.ts";
import { registerSyntax } from "./triggers.ts";

export interface RawSourceMap {
  version: number;
  file: string;
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  mappings: string;
}

export interface CompileResult {
  code: string;
  map: RawSourceMap;
  /**
   * Every file the callee-`Input` resolver read while compiling this file
   * (decision 106), including followed `import type` targets. An integration
   * invalidates this file's module when one of these changes — the Vite
   * plugin does from phase 1a — so a callee's `Input` edit cannot leave a
   * caller serving a stale attribute-tag shape. Empty until lowering
   * actually resolves a callee (task 1b wires the resolver in).
   */
  dependencies: string[];
  /** The unit's custom tag calls and declared names, input of `atomCandidates`. */
  atomFacts: AtomFacts;
}

export interface TranslatorOptions {
  /**
   * The taglibs this host registers, in `@marko/compiler`'s own
   * `[id, definition]` form. A host's own core-tag taglib goes here.
   */
  taglibs?: Array<[string, unknown]>;
  /**
   * `false` when the host declares its own statement tags in `taglibs` (the
   * data target's three) and core's six (decision 168) must not be registered
   * beside them. Unset, every parse registers core's statement tags.
   */
  statementTags?: false;
  /**
   * Directories beside a template whose `.marko`/`.mx` files are callable as
   * tags without an import. Marko's own convention is `["tags"]`; a host that
   * requires explicit imports passes `[]`.
   */
  tagDiscoveryDirs?: string[];
  /** Custom tags already loaded by the calling integration, by call name. */
  customTags?: Record<string, CustomTag>;
  /**
   * Collects positioned warnings — constructs that compile while dropping
   * something the author wrote. Unset, they print to `console.warn` as
   * before; a language server passes an array and publishes them instead.
   */
  warnings?: MxWarning[];
  /**
   * The product name diagnostics use where core's own wording says "MX"
   * (decision 183). Unset, diagnostics say `MX`, so every existing message
   * is byte-identical. A language packaged on top of MX (design note §L3)
   * passes its own name so its errors never mention a product its authors
   * did not choose.
   */
  productName?: string;
  /**
   * A synchronous import resolver (decision 107), tried before the built-in
   * relative/`require.resolve` resolution whenever lowering reads a callee
   * file. Lets a tool supply aliases — tsconfig `paths`, Vite
   * `resolve.alias` — so an aliased import resolves to the same file the
   * bundler sees instead of falling back with a stale-shape warning.
   */
  resolveImport?: (specifier: string, importer: string) => string | undefined;
  /**
   * The registered targets this compile runs under (decisions 129 and 132).
   * Required: lowering asks it which packages export the `AttrTag` type and
   * which file-kind segments exist, and core holds no list to fall back on —
   * a compile without one would silently accept a foreign `AttrTag` import
   * and misjudge a host module file. A host's own descriptor is what its
   * compile entry defaults to (design note §5.1, rule (c)).
   */
  targets: TargetLookup;
}

export interface HostOptions extends TranslatorOptions {
  /**
   * The syntax table, or a syntax module carrying one and its hooks
   * (decision 182 addendum 5). Omitted, the file's nearest
   * `package.json#mx.syntax` resolves it (`resolveSyntax`). A trigger, block
   * tag or filter nothing lowers fails the file at the first one
   * (`tableParseError`).
   */
  syntax?: SyntaxTable | SyntaxModule;
  /**
   * A last pass over the emitted module, for a host that appends helpers or
   * rewrites the module shape. Receives and returns the whole module text.
   */
  postEmit?: (code: string) => string;
  /**
   * Passed to Marko's compiler as `stripTypes`. Marko's `output: "html"`
   * defaults it to true, which erases TypeScript annotations from any
   * expression it has to reprint; type-checking tooling sets it to false to
   * keep them. Leave unset for a build.
   */
  stripTypes?: boolean;
  /** Emits the module from the lowered IR (decision 79). */
  emitIr: (ir: Ir, ctx: Ctx) => string;
  /** `package.json#mx.<target>.defaultTag`, handed to the host's `resolveDefaultTag`. */
  defaultTag?: string;
}

/**
 * The `config.translator` object `@marko/compiler` is given: the taglibs this
 * host registers plus the visitor that runs the lowering. Exported for the
 * hosts and tools that hand one to `compile` themselves (the mapping pass,
 * the oracle's stock-Marko comparison).
 */
export interface Translator {
  taglibs: Array<[string, unknown]>;
  /** `false`: this translator declares its own statement tags (data). */
  statementTags?: false;
  tagDiscoveryDirs: string[];
  translate: {
    // biome-ignore lint/style/useNamingConvention: a Marko translate visitor key is a node type
    Program: {
      exit(path: { node: { body: Node[] } }): void;
    };
  };
}

/**
 * The compile in flight.
 *
 * `translate` is a plain visitor the compiler calls; it receives the AST but
 * not the original source text or the tag table, both of which the
 * lowering needs (source for statement-tag slicing, the table for element
 * and component resolution). A module-scoped handle is how the visitor reaches
 * them. `compileSync` is synchronous and single-threaded, so there is never
 * more than one.
 */
let current: {
  source: string;
  filename: string;
  code: string | null;
  policy: Policy;
  tagTable?: TagTable;
  postEmit?: (code: string) => string;
  emitIr: (ir: Ir, ctx: Ctx) => string;
  customTags?: Readonly<Record<string, CustomTag>>;
  defaultTag?: string;
  warnings?: MxWarning[];
  productName?: string;
  resolveImport?: (specifier: string, importer: string) => string | undefined;
  targets: TargetLookup;
  dependencies: string[];
  atomFacts: AtomFacts | undefined;
} | null = null;

/**
 * Prints one expression node back to source text.
 *
 * The emitted module is text rather than a Babel AST, so every expression
 * Marko already parsed has to become code again. Marko bundles its own Babel
 * and these nodes belong to that instance, so its generator is the one that
 * can print them — the export is `generator`, not `generate`. A different
 * Babel instance's generator can still print the same node shape, but it is
 * the wrong generator for a Marko-owned node: only the instance a node's own
 * parser produced it with is guaranteed to agree with that parser's AST
 * shape and options across a version bump.
 */
export function printExpression(node: Node): string {
  const { generator } = coreBabel();
  return generator(node, { concise: true }).code;
}

/**
 * Builds the `config.translator` object for a host.
 *
 * Exported because `@marko/compiler`'s taglib lookup is keyed on the
 * translator object itself: a caller that wants the lookup (for its own tag
 * resolution) has to hand the compiler the same object it later passes to
 * `compileSync`.
 */
export function createTranslator(host: TranslatorOptions): Translator {
  return translatorClaiming(host, claimedFields(undefined));
}

/**
 * `createTranslator` for one file, whose syntax module claims `claimed`
 * contract keys (`SyntaxModule.contractFields`): registration accepts them
 * as the module's data and leaves them unchecked.
 */
function translatorClaiming(
  host: TranslatorOptions,
  claimed: ClaimedFields,
): Translator {
  rejectShadowedRegistration(host.customTags);
  rejectUnknownDeclarationKeys(host.customTags, claimed);
  rejectWildcardReferences(host.customTags);
  rejectUnreachableHooks(host.customTags);
  const customTags = customTagTaglib(host.customTags);
  // Decision 168: core's own taglib is always registered, so `static`,
  // `import`, `export`, `client`, `server` and `class` are statement tags to
  // the parser on every target. A host that already lists it (html) keeps its
  // own entry, and no host names the set.
  const hostTaglibs = host.taglibs ?? [];
  const coreTaglib: Array<[string, unknown]> =
    host.statementTags === false ||
    hostTaglibs.some(([id]) => id === CORE_TAGLIB_ID)
      ? []
      : [[STATEMENT_TAGLIB_ID, STATEMENT_TAGLIB]];
  return {
    taglibs: [
      ...coreTaglib,
      ...hostTaglibs,
      ...(customTags ? [customTags] : []),
    ],
    tagDiscoveryDirs: host.tagDiscoveryDirs ?? [],
    ...(host.statementTags === false ? { statementTags: false as const } : {}),
    translate: {
      // biome-ignore lint/style/useNamingConvention: a Marko translate visitor key is a node type
      Program: {
        exit(path: { node: { body: Node[] } }) {
          const state = current;
          if (!state) throw new Error("@mxlang/core: no compile in flight");
          const ctx = newCtx(
            state.source,
            printExpression,
            state.policy,
            state.tagTable,
            state.filename,
            state.targets,
          );
          ctx.customTags = state.customTags;
          ctx.defaultTag = state.defaultTag;
          ctx.warnings = state.warnings;
          ctx.productName = state.productName;
          ctx.resolveImport = state.resolveImport;
          // Decision 183: `newCtx` seeds `afterLower` with
          // `checkAtomContracts`; the compile entry only adds host hooks on
          // top, so non-`compileSource` lowering paths keep the check too.
          // Every host reaching `compileSource` emits a whole module with a
          // default export, so the file has a declaration to name and a tag
          // may call itself without importing itself.
          ctx.emitsModule = true;
          // Decision 162: report every error of the file, not the first.
          ctx.errors = [];
          let code: string;
          try {
            code = state.emitIr(lower(ctx, path.node.body), ctx);
          } finally {
            // Every callee `readCalleeInput` resolved before a later error
            // (e.g. a missing required attribute tag, thrown well after
            // resolving the callee whose declaration made it required) is a
            // real dependency of this compile, and the caller must keep
            // seeing it even though the compile itself failed — an LSP
            // integration's re-diagnosis graph would otherwise lose this
            // caller's edge to that callee on exactly the compile that made
            // the edge matter, and never re-check it when the callee changes
            // again.
            state.dependencies = [...(ctx.dependencies ?? [])];
            state.atomFacts = ctx.atomFacts;
          }
          state.code = state.postEmit ? state.postEmit(code) : code;
          path.node.body = [];
        },
      },
    },
  };
}

/**
 * What Babel's `run` did to an error thrown while translating, which every
 * caller of `compileSource` saw until port PR 5: the file name in front of
 * the message, and a `code` when it had none. Kept so no diagnostic changes
 * text; `dropCompiledFilePrefix` below then removes the prefix from a
 * `TranslateError`, as it always did.
 */
function asBabelTransformError(error: unknown, filename: string): unknown {
  if (error === null || typeof error !== "object") return error;
  const decorated = error as { message?: unknown; code?: unknown };
  decorated.message = `${resolve(filename)}: ${decorated.message}`;
  if (!decorated.code) decorated.code = "BABEL_TRANSFORM_ERROR";
  return error;
}

/**
 * Babel prefixes a translator error's message with `<filename>: `. A
 * `TranslateError` already carries `line`/`column` (and `file` when it is
 * about another file), so the prefix only repeats the compiled file, often as
 * an absolute path.
 *
 * The comparison is two-sided: the leading path is *extracted* from the
 * message, then both sides are compared by `resolve`/`realpathSync`
 * identities (a file missing on disk resolves only) — never by raw strings.
 * Babel may spell the file differently from the caller (a relative
 * `filename`, a symlinked directory, a different alias of the same dir), and
 * any spelling of the same file repeats it. A prefix naming a *different*
 * file is the only place that file is named and stays. Generic path logic
 * only (decision 126).
 *
 * @internal Exported for the path-identity regression tests only.
 */
export function dropCompiledFilePrefix(
  error: TranslateError,
  filename: string,
): void {
  // The prefix is `<path>: ` at the very start of the message. Taking
  // everything before the first ": " keeps spaces-in-pathnames intact and
  // fails safe: a reason that merely contains ": " yields a non-path head
  // whose identities match nothing.
  const separator = error.message.indexOf(": ");
  if (separator < 0) return;
  const head = error.message.slice(0, separator);
  if (!sameFilePath(head, filename)) return;
  // `CompileError.message`-style accessors can swallow a plain assignment.
  Object.defineProperty(error, "message", {
    value: error.message.slice(separator + 2),
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/** Every spelling of `p` that can name the same file: its lexical resolve, plus its realpath when the path exists. */
function pathIdentities(p: string): string[] {
  const resolved = resolve(p);
  try {
    return [...new Set([resolved, realpathSync(resolved)])];
  } catch {
    // Missing file: the lexical resolve is the only spelling it has.
    return [resolved];
  }
}

/** Whether two path spellings name the same file: an identity of one side appears on the other. */
function sameFilePath(a: string, b: string): boolean {
  const identities = new Set(pathIdentities(a));
  return pathIdentities(b).some((identity) => identities.has(identity));
}

/**
 * The MX document of `source` as `compileSource` parses it, without lowering
 * it: the MX front end, with the tag shapes and statement keywords of
 * `translator`'s tag table over `nativeTags` (`tagTable`) and the
 * file's syntax table (`syntax`, else its `package.json#mx.syntax`).
 * `undefined` when the template itself does not parse. An expression error
 * does not count (it stays on its container, as Marko's parse-only output
 * kept it in the tree, `parseFragment`'s rule), nor does a front-end error
 * that lowering raises (`MX_*` rules): the tree is whole. The node is
 * untyped, as everywhere at core's public boundary.
 *
 * @unstable plumbing for `@mxlang/data`'s parse-only scan.
 */
export function parseMxDocument(
  source: string,
  filename: string,
  translator: unknown,
  syntax?: SyntaxTable | SyntaxModule,
  nativeTags?: NativeTags,
): Node | undefined {
  // A syntax module's table parses; its hooks are lowering's, not the scan's.
  const table = (
    syntax !== undefined
      ? explicitSyntaxOf(syntax, filename)
      : resolveSyntaxOf(filename)
  ).table;
  const lookup = tagTable(translator, nativeTags);
  const document = parseMx(source, { syntax: table, lookup });
  return compileErrorOf(document, filename, { expressionErrors: false })
    ? undefined
    : document;
}

/**
 * Compiles one Marko template under `policy`.
 *
 * The returned map is a placeholder identity map: the emitter builds text
 * directly rather than printing a Babel AST, so there are no node positions to
 * derive real mappings from yet. Marko's nodes do carry real `loc`, so genuine
 * mappings are possible — a separate task.
 */
export function compileSource(
  source: string,
  filename: string,
  policy: Policy,
  host: HostOptions,
): CompileResult {
  // Only an absent option resolves from the manifest: `null` is refused.
  const resolvedSyntax =
    host.syntax !== undefined
      ? explicitSyntaxOf(host.syntax, filename)
      : resolveSyntaxOf(filename);
  const syntax = resolvedSyntax.table;
  const translator = translatorClaiming(
    host,
    claimedFields(resolvedSyntax.module),
  );
  const lookup = tagTable(translator, policy.nativeTags);

  const state = {
    source,
    filename,
    code: null as string | null,
    policy,
    postEmit: host.postEmit,
    emitIr: host.emitIr,
    customTags: host.customTags,
    defaultTag: host.defaultTag,
    warnings: host.warnings,
    productName: host.productName,
    resolveImport: host.resolveImport,
    targets: host.targets,
    dependencies: [] as string[],
    atomFacts: undefined,
    // The host's taglibs over the target's native elements; tags beside the
    // file reach it as `customTags`, never by a directory walk here.
    tagTable: lookup,
  };

  const previous = current;
  current = state;
  try {
    // Port PR 5: the MX front end parses, with the tag shapes the tag table
    // gives; its parse errors are thrown as the `CompileError` Marko threw,
    // and its payloads lose their TypeScript as Marko's did (`stripTypes`
    // defaults to true for a build). `@marko/compiler` no longer parses.
    const document = parseMx(source, { syntax, lookup });
    const tableError = tableParseError(
      document,
      syntax,
      { filename },
      resolvedSyntax.module,
    );
    if (tableError) throw tableError;
    const parseError = compileErrorOf(document, filename, {
      expressionErrors: true,
    });
    if (parseError) throw parseError;
    if (host.stripTypes !== false) stripMxTypes(document);
    registerDocument(document);
    registerSyntax(document, resolvedSyntax);
    try {
      translator.translate.Program.exit({ node: { body: document.body } });
    } catch (error) {
      throw asBabelTransformError(error, filename);
    }
  } catch (error) {
    if (isTranslateError(error)) {
      // Past `lower()` nothing knows the source: an MX-node error that got
      // here unpositioned is an MX bug, never a 0:0 diagnostic.
      for (const each of [error, ...(error.errors ?? [])]) {
        assertPositioned(each);
      }
      error.dependencies = state.dependencies;
      error.atomFacts = state.atomFacts;
      dropCompiledFilePrefix(error, filename);
      // The rest of the file's errors travel with the first and carry what it
      // does (decision 162); Babel only prefixed the one it rethrew.
      for (const other of error.errors ?? []) {
        if (other === error) continue;
        other.dependencies = state.dependencies;
        other.atomFacts = state.atomFacts;
      }
    }
    // The parse-error rewrites below treat an `errors` list as Marko's own
    // aggregate of parse errors; this one holds the thrown error itself
    // (decision 162), so it is set aside for them and put back after.
    const recorded = isTranslateError(error) ? error.errors : undefined;
    if (recorded && isTranslateError(error)) error.errors = undefined;
    annotateCloseTagOpener(error, source);
    hintParseError(error, source, policy);
    // A failure inside a tag's `|params|`, and sugar right after a default
    // value (decision 151, ruling 2), become positioned MX errors.
    const thrown =
      tagParamError(error, source) ??
      sugarAfterDefaultError(error, source) ??
      error;
    if (recorded && thrown === error && isTranslateError(error)) {
      error.errors = recorded;
    }
    throw thrown;
  } finally {
    current = previous;
  }

  if (state.code === null) {
    throw new Error(`${filename}: translator produced no output`);
  }

  return {
    code: state.code,
    dependencies: state.dependencies,
    atomFacts: state.atomFacts ?? emptyAtomFacts(),
    map: {
      version: 3,
      file: filename,
      sources: [filename],
      sourcesContent: [source],
      names: [],
      mappings: "",
    },
  };
}
