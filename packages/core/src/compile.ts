/**
 * The whole-file front door (decision 70): a Marko template in, an emitted
 * module out, with the host's policy deciding everything host-specific.
 *
 * Named `compileSource`, not `compileFile`: it takes source text, and a host
 * is free to keep its own disk-reading `compileFile(filename)` as its public
 * API (`@mxlang/html` does) without two different signatures sharing one
 * name across the two packages.
 *
 * This is the seam ADR 0001 names: `@marko/compiler` selects a translator by
 * `config.translator`, and a translator supplying only `translate` (plus its
 * taglibs) injects no runtime at all. The code used to live in
 * `@mxlang/html`'s `index.ts`; it is core's because the seam is the
 * same for every host — only the taglib list, the policies and any post-pass
 * over the emitted code differ, and those arrive as arguments.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { rejectShadowedRegistration } from "./builtin-tags.ts";
import { annotateCloseTagOpener } from "./close-tag-opener.ts";
import {
  type Ctx,
  isTranslateError,
  type MxWarning,
  type Node,
  newCtx,
  type TranslateError,
} from "./core.ts";
import {
  type CustomTag,
  customTagTaglib,
  rejectUnknownDeclarationKeys,
  rejectUnreachableHooks,
} from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Ir } from "./ir.ts";
import { lower } from "./lower.ts";
import { hintParseError } from "./parse-error-hints.ts";
import type { TargetLookup } from "./target-descriptor.ts";

const require = createRequire(import.meta.url);

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
}

/** The taglib lookup `@marko/compiler` builds for a translator. */
export type Lookup = NonNullable<Ctx["lookup"]>;

export interface TranslatorOptions {
  /**
   * The taglibs this host registers, in `@marko/compiler`'s own
   * `[id, definition]` form. A host's own core-tag taglib goes here.
   */
  taglibs?: Array<[string, unknown]>;
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
}

/**
 * The `config.translator` object `@marko/compiler` is given: the taglibs this
 * host registers plus the visitor that runs the lowering. Exported for the
 * hosts and tools that hand one to `compile` themselves (the mapping pass,
 * the oracle's stock-Marko comparison).
 */
export interface Translator {
  taglibs: Array<[string, unknown]>;
  tagDiscoveryDirs: string[];
  translate: {
    Program: {
      exit(path: { node: { body: Node[] } }): void;
    };
  };
}

/**
 * The compile in flight.
 *
 * `translate` is a plain visitor the compiler calls; it receives the AST but
 * not the original source text or the taglib lookup, both of which the
 * lowering needs (source for statement-tag slicing, lookup for element and
 * component resolution). A module-scoped handle is how the visitor reaches
 * them. `compileSync` is synchronous and single-threaded, so there is never
 * more than one.
 */
let current: {
  source: string;
  filename: string;
  code: string | null;
  policy: Policy;
  lookup?: Lookup;
  postEmit?: (code: string) => string;
  emitIr: (ir: Ir, ctx: Ctx) => string;
  customTags?: Readonly<Record<string, CustomTag>>;
  warnings?: MxWarning[];
  resolveImport?: (specifier: string, importer: string) => string | undefined;
  targets: TargetLookup;
  dependencies: string[];
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
  const { generator } = require("@marko/compiler/internal/babel");
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
  rejectShadowedRegistration(host.customTags);
  rejectUnknownDeclarationKeys(host.customTags);
  rejectUnreachableHooks(host.customTags);
  const customTags = customTagTaglib(host.customTags);
  return {
    taglibs: [...(host.taglibs ?? []), ...(customTags ? [customTags] : [])],
    tagDiscoveryDirs: host.tagDiscoveryDirs ?? [],
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
            state.lookup,
            state.filename,
            state.targets,
          );
          ctx.customTags = state.customTags;
          ctx.warnings = state.warnings;
          ctx.resolveImport = state.resolveImport;
          // Every host reaching `compileSource` emits a whole module with a
          // default export, so the file has a declaration to name and a tag
          // may call itself without importing itself.
          ctx.emitsModule = true;
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
          }
          state.code = state.postEmit ? state.postEmit(code) : code;
          path.node.body = [];
        },
      },
    },
  };
}

/**
 * Babel prefixes a translator error's message with `<filename>: `. A
 * `TranslateError` already carries `line`/`column` (and `file` when it is
 * about another file), so the prefix only repeats the compiled file, often as
 * an absolute path.
 */
function dropCompiledFilePrefix(error: TranslateError, filename: string): void {
  const prefix = `${filename}: `;
  if (!error.message.startsWith(prefix)) return;
  // `CompileError.message`-style accessors can swallow a plain assignment.
  Object.defineProperty(error, "message", {
    value: error.message.slice(prefix.length),
    enumerable: false,
    writable: true,
    configurable: true,
  });
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
  // Required lazily and by CJS: `@marko/compiler` is a large dependency and
  // only this function needs it, so importing the type surface stays free.
  const compiler = require("@marko/compiler");
  const translator = createTranslator(host);

  const state = {
    source,
    filename,
    code: null as string | null,
    policy,
    postEmit: host.postEmit,
    emitIr: host.emitIr,
    customTags: host.customTags,
    warnings: host.warnings,
    resolveImport: host.resolveImport,
    targets: host.targets,
    dependencies: [] as string[],
    // The lookup is keyed on the translator object, so asking for it here gets
    // exactly the taglibs this host registers plus Marko's own element
    // taglibs — and the tag-discovery directories beside this particular file.
    lookup: compiler.taglib.buildLookup(dirname(filename), translator) as
      | Lookup
      | undefined,
  };

  const previous = current;
  current = state;
  try {
    compiler.compileSync(source, filename, {
      translator,
      output: "html",
      ...(host.stripTypes === undefined ? {} : { stripTypes: host.stripTypes }),
      writeVersionComment: false,
    });
  } catch (error) {
    if (isTranslateError(error)) {
      error.dependencies = state.dependencies;
      dropCompiledFilePrefix(error, filename);
    }
    annotateCloseTagOpener(error, source);
    hintParseError(error, source, policy);
    throw error;
  } finally {
    current = previous;
  }

  if (state.code === null) {
    throw new Error(`${filename}: translator produced no output`);
  }

  return {
    code: state.code,
    dependencies: state.dependencies,
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
