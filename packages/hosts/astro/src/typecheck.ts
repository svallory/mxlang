/**
 * The runtime surface a type-checked `.mx` module imports, as types only.
 *
 * An html-compiled module imports `escape`, `createOut` and `Out` from
 * `@mxlang/html`. A project that installed `@mxlang/astro` under an isolated
 * linker (bun workspaces, pnpm) cannot resolve that bare name, and the error
 * would sit on generated text no source position maps to, so tooling drops
 * it and every one of those names silently becomes `any`. The type-check
 * projection of a compiled module (`descriptor.ts`, `runtimeFrom`) imports
 * from this subpath instead: a project resolves `@mxlang/astro`, and from
 * here `@mxlang/html` resolves as this package's own dependency.
 *
 * Declarations only. Nothing imports this module at run time: the build
 * compiles `.mx` to import `@mxlang/html`, resolved by `html-resolve.ts`.
 */
import type * as html from "@mxlang/html";

export type { AttrTag, BufferedOut, Out } from "@mxlang/html";
// biome-ignore lint/suspicious/noShadowRestrictedNames: the name is the emitted module's import, same as core's `escape`
export declare const escape: typeof html.escape;
export declare const createOut: typeof html.createOut;
export declare const createBufferedOut: typeof html.createBufferedOut;
