/**
 * `@mxlang/preact` — MX's Preact host, the fourth emitter on `@mxlang/core`'s
 * IR (decisions 71, 79, 81, 82).
 *
 * A `.mx` template becomes a Preact component module: a JSX file
 * carrying its own `@jsxImportSource` pragma, the author's imports and `static`
 * blocks at module scope, their `export interface Input` as the component's
 * props type, and one default-exported function returning JSX.
 *
 * Everything generic — parsing Marko, resolving to the IR, the
 * `config.translator` seam — is `@mxlang/core`'s. This package supplies the
 * declarations (`emitter.ts`), the lowering, and the one small runtime `<try>`
 * needs (`runtime.ts`).
 *
 * The compile entry and the module emitter live in `./compile.ts`, a
 * descriptor-free leaf: this module composes the package's own target lookup
 * over `./descriptor.ts` and defaults a direct entry to it, while the
 * descriptor — a bundler entry itself — reaches the compile entry through the
 * leaf instead of through here, keeping the entry graph acyclic (rev-245
 * BUG 1).
 *
 * ## Emitted module shape
 *
 * ```tsx
 * \/** @jsxImportSource preact *\/
 * import { Fragment } from "preact";
 * <the author's own imports and static blocks>
 *
 * export interface Input { … }
 *
 * export default function <Name>(props: Input) {
 *   const input = { ...props, content: props.content ?? props.children };
 *   <const> and <define> bindings, in source order
 *   return (<jsx/>);
 * }
 * ```
 *
 * `<Name>` is derived from the file (`card.mx` -> `Card`), never anonymous:
 * a tag whose template calls its own name resolves to that declaration, so
 * self-recursion needs no self-import (design invariant §7.5-7).
 *
 * The template's own expressions read `input`, because that is the name MX
 * templates already use (`${input.title}`) and renaming it at the boundary
 * would make every one of them wrong. The JSX parameter is `props`, and the
 * first line bridges the two: Marko spells a component's ordinary children
 * `content` while JSX spells the same slot `children`, and this host emits
 * calls the JSX way so that a hand-written Preact component can be called
 * from MX. Without the bridge, `<Card><p/></Card>` compiled cleanly and
 * rendered an empty card.
 *
 * ## Hooks
 *
 * A hook call belongs in the *component body*, which is what `<const>` lowers
 * to — `<const/count=useState(0)/>` emits `const count = useState(0);` inside
 * the function, where the rules of hooks are satisfied. A `static` block is
 * module scope and runs once per module, so a hook there would be a rules-of-
 * hooks violation; that is a property of the target, and the README says so
 * rather than this file trying to detect it.
 */

import {
  type AttrTagConfig,
  type AttrTagOf,
  type CompileResult,
  createTargetLookup,
  createTranslator,
  type RawSourceMap,
  type TargetLookup,
  type Translator,
} from "@mxlang/core";
import type { ComponentChildren } from "preact";
import {
  type CompilePreactOptions,
  type CompilePreactResult,
  compilePreactFile as compilePreactFileWith,
  compilePreactMx as compilePreactMxWith,
  emitModule,
  emitModuleWithMappings,
  host,
} from "./compile.ts";
import descriptor from "./descriptor.ts";

export type { AttrTagConfig, AttrTagOf } from "@mxlang/core";
// Re-exported for the hosts built on this emitter (`@mxlang/react`,
// `@mxlang/hono`), which depend on this package rather than on the core
// directly. Their Bun loaders need tag discovery, and a second dependency
// edge only to reach one function would contradict that arrangement.
export {
  getCustomTags,
  reportScanDiagnostics,
  scanCached,
  TranslateError,
} from "@mxlang/core";
export { type JsxDialect, preactDialect } from "./dialect.ts";
export {
  createEmitter,
  createJsxDeclarations,
  emitPreact,
  PreactEmitter,
  preactDeclarations,
} from "./emitter.ts";
export { MxErrorBoundary, MxPlaceholder, mxClass } from "./runtime.ts";
export type {
  CompilePreactOptions,
  CompilePreactResult,
  CompileResult,
  RawSourceMap,
};
export { emitModule, emitModuleWithMappings };

/** Attribute-tag value specialised to Preact's renderable child type. */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: public default from decision 106
  C extends AttrTagConfig = {},
> = AttrTagOf<C, ComponentChildren>;

/**
 * This package's own target table (decisions 129 and 132): the one descriptor
 * it exports. The default for a direct entry that names no lookup of its own
 * (`@mxlang/preact/bun` and its siblings, which route through here — see
 * design note §5.1, rule (c)). A tool compiling several targets passes the
 * full registry's lookup through `options.targets` instead.
 */
const ownTargets: TargetLookup = createTargetLookup([descriptor]);

/** The Marko translator object, for a caller driving `@marko/compiler` itself. */
export const translator: Translator = createTranslator({
  ...host,
  targets: ownTargets,
});

/**
 * Compiles a `.mx` template to a Preact component module.
 *
 * `options.targets` defaults to this package's own lookup; see
 * {@link CompilePreactOptions.targets}.
 */
export function compilePreactMx(
  source: string,
  filename: string,
  options: CompilePreactOptions = {},
): CompilePreactResult {
  return compilePreactMxWith(source, filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}

/** `compilePreactMx()` over a file on disk. */
export function compilePreactFile(
  filename: string,
  options: CompilePreactOptions = {},
): CompileResult {
  return compilePreactFileWith(filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}
