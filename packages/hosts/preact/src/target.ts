/**
 * The knobs that separate Preact from React, isolated from the emitter.
 *
 * The lowering itself — ternary chains, `.map` with `key`, attribute tags as
 * props, an error boundary around `<try>` — is identical for both targets.
 * What differs is a short list of *names*: the JSX runtime the emitted pragma
 * points at, whether a class attribute is spelled `class` or `className`, and
 * the prop that sets raw HTML. Keeping them in one object is what lets a
 * future `@mxlang/react` import this package's emitter and pass a different
 * `Target` rather than fork 600 lines that would then drift.
 *
 * Deliberately *not* in here: anything the emitter would have to branch on
 * structurally. A knob that required an `if (target.kind === "react")` in the
 * emitter is a sign the two targets have genuinely diverged, and belongs in a
 * second emitter rather than in a boolean here.
 */

export interface Target {
  /** Human-readable target name used in host-specific diagnostics. */
  name: string;
  /** Value of the emitted `/** @jsxImportSource … *\/` pragma. */
  jsxImportSource: string;
  /**
   * How this target spells the class attribute in JSX.
   *
   * Preact accepts both `class` and `className`; `class` is its native prop
   * and what its own documentation uses, so that is what MX emits — an MX
   * author writes `class=` and reads `class=` back out of the generated JSX.
   */
  classAttr: string;
  /** How this target spells HTML's `for` attribute in JSX. */
  forAttr: string;
  /** The prop that sets raw HTML from a sole `$!{expr}` child. */
  rawHtmlProp: string;
  /**
   * How raw HTML is wrapped for that prop. Both targets take
   * `{ __html: expr }`; kept here because it is target vocabulary, not a
   * structural decision.
   */
  rawHtmlValue(code: string): string;
  /** Module the emitted `<try>` lowering imports its error boundary from. */
  errorBoundaryModule: string;
  /**
   * Module `mxClass` is imported from. Defaults to `errorBoundaryModule`
   * when omitted — Preact's and React's own `/runtime` entry ships both.
   * Hono needs its own package's `mxClass` (Hono has none built in) while
   * still importing `ErrorBoundary`/`Suspense` from `hono/jsx` itself, so
   * this is a separate knob rather than reusing `errorBoundaryModule`.
   */
  mxClassModule?: string;
  /** Named export in that module: a component taking `fallback` and children. */
  errorBoundaryName: string;
  /**
   * The prop `errorBoundaryName` takes its fallback under. Both Preact's and
   * React's hand-rolled boundaries take a `fallback` node/function; Hono's
   * *built-in* `ErrorBoundary` takes a `fallbackRender` function instead
   * (`(error: Error) => Child`), so this is a target knob rather than an
   * emitter constant. Defaults to `"fallback"` when a target omits it, which
   * is why Preact and React need no change here.
   */
  errorBoundaryFallbackProp?: string;
  /**
   * When true, `errorBoundaryFallbackProp` always takes a function, even when
   * `<@catch>` declared no params (Hono's `fallbackRender: (error: Error) =>
   * Child` has no non-function form). Preact's and React's hand-rolled
   * boundaries accept either a node or a function, so they omit this.
   */
  errorBoundaryFallbackAlwaysFunction?: boolean;
  /** Named export in that module: the `<try>` placeholder/suspense wrapper. */
  suspenseName: string;
  /** Module the JSX `Fragment` is imported from, for an explicit import. */
  fragmentModule: string;
  /**
   * This target's event-prop names, keyed by DOM event name — the value is
   * the middle of the prop (`"KeyDown"` → `onKeyDown`), so the plain
   * `on` + capitalized-DOM-name recomposition is the fallback, not the
   * rule. Only the React target sets this, and it is a *lookup into React's
   * own registration table*, vendored in
   * `@mxlang/react`'s `target.ts` (`buildReactEventPropNames`, from
   * react-dom's `simpleEventPluginEvents` plus the registrations outside
   * that loop): React's names are camelCase data lowercased for the DOM,
   * which no derivation can reverse (`keydown` → `onKeyDown`, never
   * `onKeydown`). Preact and hono omit this and get the plain
   * recomposition (`dblclick` → `onDblclick`).
   */
  eventPropNames?: Record<string, string>;
}

/** The Preact target. */
export const preactTarget: Target = {
  name: "Preact",
  jsxImportSource: "preact",
  classAttr: "class",
  forAttr: "for",
  rawHtmlProp: "dangerouslySetInnerHTML",
  rawHtmlValue: (code) => `{ __html: ${code} }`,
  errorBoundaryModule: "@mxlang/preact/runtime",
  errorBoundaryName: "MxErrorBoundary",
  suspenseName: "MxPlaceholder",
  fragmentModule: "preact",
};
