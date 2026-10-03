// Import the light subpaths, not the package root: the root is preact's
// compile entry, and a descriptor's dependencies must stay light
// (target-registry's light-import test).
import type { JsxDialect } from "@mxlang/preact/dialect";
import { createJsxDeclarations } from "@mxlang/preact/emitter";

/** Hono vocabulary for the shared Preact/React/Hono JSX emitter. */
export const honoDialect: JsxDialect = {
  name: "Hono",
  jsxImportSource: "hono/jsx",
  attrTagModule: "@mxlang/hono",
  classAttr: "class",
  forAttr: "for",
  rawHtmlProp: "dangerouslySetInnerHTML",
  rawHtmlValue: (code) => `{ __html: ${code} }`,
  errorBoundaryModule: "hono/jsx",
  // Hono ships no `mxClass` equivalent; this package's own runtime supplies
  // it, the same shape as Preact's/React's `/runtime` but scoped to just this
  // one helper since Hono needs no error-boundary class of its own.
  mxClassModule: "@mxlang/hono/runtime",
  errorBoundaryName: "ErrorBoundary",
  // Hono's built-in `ErrorBoundary` takes `fallbackRender`, not `fallback`,
  // and that prop is always a function — `(error: Error) => Child` — with no
  // non-function form the way Preact's/React's hand-rolled boundaries allow.
  errorBoundaryFallbackProp: "fallbackRender",
  errorBoundaryFallbackAlwaysFunction: true,
  suspenseName: "Suspense",
  fragmentModule: "hono/jsx",
  hookModules: ["hono/jsx"],
};

/** Resolve-time policy shared structurally with Preact/React, Hono diagnostics. */
export const honoDeclarations = createJsxDeclarations("Hono");
