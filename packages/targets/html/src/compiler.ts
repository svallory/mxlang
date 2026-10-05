/**
 * The html host's compile entry, as a **descriptor-free leaf**.
 *
 * `descriptor.ts` must stay a leaf: it is a bundler entry (`@mxlang/html/descriptor`)
 * and the registry bundles it into tools, so it may never `require` a module
 * that (transitively) imports it. The compile entry therefore lives here,
 * where nothing reaches for `./descriptor.ts`, and both `index.ts` (the public
 * entry, which composes the package's own lookup) and `descriptor.ts` (which
 * composes a lookup over itself, lazily) call in with an explicit lookup.
 *
 * Revision BUG 1 (rev-245 §1): when the descriptor reached the compile entry
 * through `require("./index.ts")` and the index imported the descriptor back,
 * Bun's multi-entry build silently dropped `dist/index.js` with exit 0 on the
 * pinned Bun 1.3.14. The acyclic graph is what makes the bundler keep every
 * entry (`packages/target-registry/src/bundle-smoke.test.ts` pins it).
 */

import { readFileSync } from "node:fs";
import {
  type CompileResult,
  type CustomTag,
  compileSource,
  createTranslator,
  type GeneratedMapping,
  type MappedCode,
  type MxWarning,
  type TargetLookup,
  type Translator,
} from "@mxlang/core";
import markoTaglib from "../taglib/marko.json" with { type: "json" };
import { emitModuleWithMappings } from "./emitter.ts";
import {
  escapeFrom,
  finalizeModule,
  finalizeModuleWithMappings,
  policy,
  strictPolicy,
} from "./translate.ts";

/**
 * The Marko translator config a compile runs under: this host's taglib, plus
 * the tag-discovery directories (`tags/`) Marko's own convention uses.
 * `tagDiscoveryDirs: ["tags"]` is Marko's own convention: `@marko/compiler`'s
 * `scanTagsDir` only auto-discovers files whose extension is literally
 * `.marko` (measured in `@marko/compiler` 5.42.5's `loadTaglibFromDir.js`,
 * `ext === ".marko"`) — a `.mx` file in a `tags/` directory is not
 * discovered as a tag at all. This host still accepts only `.mx` at the
 * loader boundary; a `tags/*.marko` file is real Marko syntax read by
 * `@marko/compiler` itself during discovery, not a second entry point this
 * host advertises.
 */
const host = {
  taglibs: [["mx-translator-core", markoTaglib]] as Array<[string, unknown]>,
  tagDiscoveryDirs: ["tags"],
};

/** One translator per lookup: Marko keys its taglib cache on the translator object, so a shared instance keeps that cache stable. */
const translators = new WeakMap<TargetLookup, Translator>();

/**
 * The Marko translator object, for `compile(src, file, { translator })`, over
 * `targets`. A caller that drives `@marko/compiler` itself (the oracle's
 * stock-Marko comparison) builds one through here; `index.ts` exports the
 * instance over the package's own lookup.
 */
export function createHtmlTranslator(targets: TargetLookup): Translator {
  let translator = translators.get(targets);
  if (!translator) {
    translator = createTranslator({ ...host, targets });
    translators.set(targets, translator);
  }
  return translator;
}

export interface CompileOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /**
   * The registered targets this compile runs under. `index.ts` defaults it
   * to this package's own descriptor, which is right for a direct entry and
   * for a tool that only ever compiles html; a tool compiling several
   * targets (the language server, `mx-tsc`, the Vite plugin) passes the
   * built-in registry's lookup, so a callee importing `AttrTag` from
   * another registered target's package reads the same as it does today.
   */
  targets?: TargetLookup;
  /**
   * Rejects reactive constructs (`<let>`, `<effect>`, `<lifecycle>`,
   * `<script>`, `client` blocks, `<id>`) by name instead of rendering their
   * initial value or treating them as inert. Folded from `.mx`'s dialect
   * (decision 68) as an opt-in stance for an author who wants those
   * constructs to be a compile error rather than silently accepted.
   */
  strict?: boolean;
  /** `package.json#mx.html.defaultTag`, already validated; the unnamed tag's name when set (decision 145). */
  defaultTag?: string;
  /**
   * Collects positioned warnings — constructs that compile while dropping
   * something the author wrote (content a tag template never placed, an
   * attribute tag a transform never read).
   *
   * Unset, they print to `console.warn` exactly as before. The language server
   * passes an array so they reach the editor as diagnostics, which is the one
   * place a silent-drop report is worth anything.
   */
  warnings?: MxWarning[];
  resolveImport?: (specifier: string, importer: string) => string | undefined;
}

export interface CompileHtmlResult extends CompileResult {
  mappings: GeneratedMapping[];
}

/**
 * Compiles a `.mx` template to a runtime-free TypeScript module, under an
 * explicit `targets` lookup.
 *
 * The emitted module imports `escape` and default-exports
 * `(input: Input) => string` — nothing else is required at run time. This is
 * the "expressions-only" output mode of `notes/marko-runtime-modes.md`,
 * implemented as a translator rather than a fork.
 *
 * The returned map is a placeholder identity map: the emitter builds text
 * directly rather than printing a Babel AST, so there are no node positions to
 * derive real mappings from yet.
 */
export function compileHtml(
  source: string,
  filename: string,
  options: CompileOptions & { targets: TargetLookup },
): CompileHtmlResult {
  let emitted: MappedCode | null = null;
  let mappings: GeneratedMapping[] = [];
  const result = compileSource(
    source,
    filename,
    options.strict ? strictPolicy : policy,
    {
      ...host,
      customTags: options.customTags,
      defaultTag: options.defaultTag,
      warnings: options.warnings,
      resolveImport: options.resolveImport,
      targets: options.targets,
      // Decision 79: this host emits from the core's IR. `postEmit` still
      // appends the helpers a template actually calls and brands the default
      // export, both of which are properties of this target rather than of
      // the core.
      emitIr: (ir) => {
        emitted = emitModuleWithMappings(ir, escapeFrom);
        return emitted.code;
      },
      postEmit: (code) => {
        if (!emitted || emitted.code !== code) return finalizeModule(code);
        const finalized = finalizeModuleWithMappings(emitted);
        mappings = finalized.mappings;
        return finalized.code;
      },
    },
  );
  return { ...result, mappings };
}

/** `compileHtml()` over a file on disk. */
export function compileHtmlFile(
  filename: string,
  options: CompileOptions & { targets: TargetLookup },
): CompileResult {
  return compileHtml(readFileSync(filename, "utf8"), filename, options);
}

/**
 * Compiles a set of templates, returning the emitted module for each.
 *
 * The CLI-free equivalent of a build step: a caller writes the results
 * wherever its own pipeline wants them.
 */
export function compileHtmlBuild(
  filenames: string[],
  options: CompileOptions & { targets: TargetLookup },
): Map<string, CompileResult> {
  const results = new Map<string, CompileResult>();
  for (const filename of filenames) {
    results.set(filename, compileHtmlFile(filename, options));
  }
  return results;
}
