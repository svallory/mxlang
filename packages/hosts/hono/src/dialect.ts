// Import the light subpaths, not the package root: the root is preact's
// compile entry, and a descriptor's dependencies must stay light
// (target-registry's light-import test).
import { honoEventPropNames, type JsxDialect } from "@mxlang/preact/dialect";
import { createJsxDeclarations } from "@mxlang/preact/emitter";

/** Hono vocabulary for the shared Preact/React/Hono JSX emitter. */
export const honoDialect: JsxDialect = {
  name: "Hono",
  jsxImportSource: "hono/jsx",
  attrTagModule: "@mxlang/hono",
  classAttr: "class",
  forAttr: "for",
  textareaContent: "children",
  textareaLeadingNewline: "ssr",
  rawHtmlProp: "dangerouslySetInnerHTML",
  rawHtmlValue: (code) => `{ __html: ${code} }`,
  // `<try>` lowers to this package's own `MxErrorBoundary`, which wraps
  // `hono/jsx`'s async `ErrorBoundary` around the body thunk; `Suspense` is
  // re-exported from the same module (the emitter imports both from one).
  errorBoundaryModule: "@mxlang/hono/runtime",
  mxClassModule: "@mxlang/hono/runtime",
  errorBoundaryName: "MxErrorBoundary",
  suspenseName: "Suspense",
  fragmentModule: "hono/jsx",
  eventPropNames: honoEventPropNames,
  closedEventPropNames: true,
  hookModules: ["hono/jsx"],
};

/** Resolve-time policy shared structurally with Preact/React, Hono diagnostics. */
export const honoDeclarations = createJsxDeclarations("Hono");

/** {@link honoDeclarations} for a `.hono.mx` region: hook errors name the surrounding component. */
export const honoRegionDeclarations = createJsxDeclarations("Hono", {
  region: true,
});
