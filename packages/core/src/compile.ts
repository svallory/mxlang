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
import { type Ctx, type MxWarning, type Node, newCtx } from "./core.ts";
import {
  type CustomTag,
  customTagTaglib,
  rejectUnknownDeclarationKeys,
  rejectUnreachableHooks,
} from "./custom-tags.ts";
import type { Policy } from "./declarations.ts";
import type { Ir } from "./ir.ts";
import { lower } from "./lower.ts";

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
}

export interface HostOptions extends TranslatorOptions {
  /**
   * A last pass over the emitted module, for a host that appends helpers or
   * rewrites the module shape. Receives and returns the whole module text.
   */
  postEmit?: (code: string) => string;
  /** Emits the module from the lowered IR (decision 79). */
  emitIr: (ir: Ir, ctx: Ctx) => string;
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
} | null = null;

/**
 * Prints one expression node back to source text.
 *
 * The emitted module is text rather than a Babel AST, so every expression
 * Marko already parsed has to become code again. Marko bundles its own Babel
 * and these nodes belong to that instance, so its generator is the one that
 * can print them — the export is `generator`, not `generate`.
 */
function printExpression(node: unknown): string {
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
export function createTranslator(host: TranslatorOptions = {}) {
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
          );
          ctx.customTags = state.customTags;
          ctx.warnings = state.warnings;
          // Every host reaching `compileSource` emits a whole module with a
          // default export, so the file has a declaration to name and a tag
          // may call itself without importing itself.
          ctx.emitsModule = true;
          const code = state.emitIr(lower(ctx, path.node.body), ctx);
          state.code = state.postEmit ? state.postEmit(code) : code;
          path.node.body = [];
        },
      },
    },
  };
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
      writeVersionComment: false,
    });
  } finally {
    current = previous;
  }

  if (state.code === null) {
    throw new Error(`${filename}: translator produced no output`);
  }

  return {
    code: state.code,
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
