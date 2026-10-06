/**
 * The runtime surface a type-checked `.mx` module imports, as types only.
 *
 * An html-compiled module imports `escape`, `createOut`, `createBufferedOut`
 * and the `Out`, `BufferedOut` and `AttrTag` types from `@mxlang/html`. A
 * project that installed `@mxlang/astro` under an isolated linker (bun
 * workspaces, pnpm) cannot resolve that bare name, and the error would sit on
 * generated text no source position maps to, so tooling drops it and every one
 * of those names silently becomes `any`. The type-check projection of a
 * compiled module (`descriptor.ts`, `runtimeFrom`) imports from this subpath
 * instead: a project resolves `@mxlang/astro`, and from here `@mxlang/html`
 * resolves as this package's own dependency.
 *
 * A re-export of the whole package, not a list: a name the emitter starts to
 * import is then reachable without touching this file (`typecheck.test.ts`
 * fails if one is not). Nothing imports this module at run time: the build
 * compiles `.mx` to import `@mxlang/html`, resolved by `html-resolve.ts`.
 */
export * from "@mxlang/html";
