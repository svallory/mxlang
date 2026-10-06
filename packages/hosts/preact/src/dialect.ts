/**
 * The knobs that separate Preact from React, isolated from the emitter.
 *
 * The lowering itself — ternary chains, `.map` with `key`, attribute tags as
 * props, an error boundary around `<try>` — is identical for both dialects.
 * What differs is a short list of *names*: the JSX runtime the emitted pragma
 * points at, whether a class attribute is spelled `class` or `className`, and
 * the prop that sets raw HTML. Keeping them in one object is what lets a
 * future `@mxlang/react` import this package's emitter and pass a different
 * `JsxDialect` rather than fork 600 lines that would then drift.
 *
 * Deliberately *not* in here: anything the emitter would have to branch on
 * structurally. A knob that required an `if (dialect.kind === "react")` in the
 * emitter is a sign the two dialects have genuinely diverged, and belongs in a
 * second emitter rather than in a boolean here.
 */

export interface JsxDialect {
  /** Human-readable dialect name used in host-specific diagnostics. */
  name: string;
  /** Value of the emitted `/** @jsxImportSource … *\/` pragma. */
  jsxImportSource: string;
  /** Package that exports this dialect's specialised `AttrTag` type. */
  attrTagModule: string;
  /**
   * How this dialect spells the class attribute in JSX.
   *
   * Preact accepts both `class` and `className`; `class` is its native prop
   * and what its own documentation uses, so that is what MX emits — an MX
   * author writes `class=` and reads `class=` back out of the generated JSX.
   */
  classAttr: string;
  /** How this dialect spells HTML's `for` attribute in JSX. */
  forAttr: string;
  /**
   * True when the renderer treats HTML boolean attributes as presence-only
   * properties (React): `true` is the only way to print one, so the
   * primitive-attribute normalization passes `true` for them.
   */
  reactBooleanAttributes?: boolean;
  /**
   * How a native `<textarea>`'s content (Marko renders `value` as content) is
   * handed to the renderer. `"children"` (Preact, Hono) passes a text child;
   * `"value"` (React) passes the controlled `value` prop, which react-dom
   * renders as content on the server and keeps in sync on a client update
   * (`defaultValue` is write-once, so a client update would change nothing).
   */
  textareaContent: "children" | "value";
  /**
   * When the doubled leading newline Marko writes (the HTML parser drops a
   * textarea's first one) must be added: `"ssr"` only where no `document`
   * exists (Preact: its client renderer sets the text through the DOM, which
   * drops nothing; Hono too: `hono/jsx/dom`'s `render` accepts these nodes
   * and sets the text through the DOM), `"never"` where the renderer already
   * does it (React). `"always"` is for a renderer that can only write markup.
   */
  textareaLeadingNewline: "ssr" | "always" | "never";
  /** The prop that sets raw HTML from a sole `$!{expr}` child. */
  rawHtmlProp: string;
  /**
   * How raw HTML is wrapped for that prop. Both dialects take
   * `{ __html: expr }`; kept here because it is dialect vocabulary, not a
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
   * (`(error: Error) => Child`), so this is a dialect knob rather than an
   * emitter constant. Defaults to `"fallback"` when a dialect omits it, which
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
   * This dialect's event-prop names, keyed by DOM event name — the value is
   * the middle of the prop (`"KeyDown"` → `onKeyDown`), so the plain
   * `on` + capitalized-DOM-name recomposition is the fallback, not the
   * rule. React's is a *lookup into React's own registration table*, vendored in
   * `@mxlang/react`'s `dialect.ts` (`buildReactEventPropNames`, from
   * react-dom's `simpleEventPluginEvents` plus the registrations outside
   * that loop): React's names are camelCase data lowercased for the DOM,
   * which no derivation can reverse (`keydown` → `onKeyDown`, never
   * `onKeydown`). Preact and hono look theirs up in the camelCase names
   * their JSX types declare ({@link CAMEL_EVENT_NAMES}).
   */
  eventPropNames?: Record<string, string>;
  /**
   * Module specifiers whose hook imports (`use*`) are refused inside a
   * returning unit (`rejectHooksInReturningUnit`, `index.ts`). A returning
   * unit is invoked as a plain function on every JSX dialect, so a hook
   * dispatcher would bind to the *calling* component instead — the same
   * failure mode regardless of which of these three dialects compiled the
   * file. A list of module specifiers rather than a name test alone: a
   * local helper called `useTotal` is ordinary code, while `useState`
   * imported from one of these is the thing that breaks.
   *
   * **Not the same list for every dialect.** Each host only needs to guard
   * the modules it can actually resolve a hook import from: Preact's own
   * `preact/hooks` and `preact/compat`, *plus* `react` — `preact/compat`'s
   * whole purpose is making `import { useState } from "react"` resolve
   * under Preact, so a Preact-compiled returning unit can reach a real hook
   * dispatcher through that specifier too. React and Hono have no such
   * alias for each other's or Preact's modules, so their lists stay
   * narrower — `["react"]` and `["hono/jsx"]` respectively, not the same
   * four-item list this field used to be everywhere.
   */
  hookModules: readonly string[];
}

/**
 * The camelCase spelling of every DOM event the Preact and Hono JSX types
 * declare a handler prop for (the middle of the prop: `"KeyDown"` →
 * `onKeyDown`), the union of `preact`'s `jsx.d.ts` and `hono/jsx`'s
 * `intrinsic-elements.d.ts`, less `dblclick`, which the two spell differently
 * (`onDblClick` / `onDoubleClick`; see {@link preactEventPropNames} and
 * {@link honoEventPropNames}).
 *
 * The shared emitter recomposes a handler prop from the DOM event name core
 * resolved. Without this lookup `keydown` became `onKeydown`, which neither
 * type set declares (TS2322 on valid code under `mx-tsc`, decision 161).
 * Preact (it lowercases `onKeydown` to find the DOM property) and hono's DOM
 * renderer both still bound the old spelling at run time, so the bug was in
 * the type-check only; the names are still data to look up, not a rule to
 * derive. `src/event-names.test.ts` compares this list against the installed
 * type files.
 */
export const CAMEL_EVENT_NAMES: readonly string[] = [
  "Abort",
  "AnimationCancel",
  "AnimationEnd",
  "AnimationIteration",
  "AnimationStart",
  "AuxClick",
  "BeforeInput",
  "BeforeToggle",
  "Blur",
  "Cancel",
  "CanPlay",
  "CanPlayThrough",
  "Change",
  "Click",
  "Close",
  "Command",
  "CompositionEnd",
  "CompositionStart",
  "CompositionUpdate",
  "ContextMenu",
  "Copy",
  "Cut",
  "Drag",
  "DragEnd",
  "DragEnter",
  "DragExit",
  "DragLeave",
  "DragOver",
  "DragStart",
  "Drop",
  "DurationChange",
  "Emptied",
  "Encrypted",
  "Ended",
  "EnterPictureInPicture",
  "Error",
  "Focus",
  "FocusIn",
  "FocusOut",
  "FormData",
  "FullscreenChange",
  "FullscreenError",
  "Input",
  "Invalid",
  "KeyDown",
  "KeyPress",
  "KeyUp",
  "LeavePictureInPicture",
  "Load",
  "LoadedData",
  "LoadedMetadata",
  "LoadStart",
  "MouseDown",
  "MouseEnter",
  "MouseLeave",
  "MouseMove",
  "MouseOut",
  "MouseOver",
  "MouseUp",
  "MouseWheel",
  "Paste",
  "Pause",
  "Play",
  "Playing",
  "PointerCancel",
  "PointerDown",
  "PointerEnter",
  "PointerLeave",
  "PointerMove",
  "PointerOut",
  "PointerOver",
  "PointerUp",
  "Progress",
  "RateChange",
  "Reset",
  "Resize",
  "Scroll",
  "ScrollEnd",
  "ScrollSnapChange",
  "ScrollSnapChanging",
  "Search",
  "Seeked",
  "Seeking",
  "Select",
  "SelectChange",
  "Stalled",
  "Submit",
  "Suspend",
  "TimeUpdate",
  "Toggle",
  "TouchCancel",
  "TouchEnd",
  "TouchMove",
  "TouchStart",
  "TransitionCancel",
  "TransitionEnd",
  "TransitionRun",
  "TransitionStart",
  "VolumeChange",
  "Waiting",
  "Wheel",
];

function eventPropNames(dblclick: string): Record<string, string> {
  const names: Record<string, string> = { dblclick };
  for (const name of CAMEL_EVENT_NAMES) names[name.toLowerCase()] = name;
  return names;
}

/** DOM event name → Preact's JSX handler prop middle (`dblclick` → `DblClick`). */
export const preactEventPropNames: Record<string, string> =
  eventPropNames("DblClick");

/** DOM event name → Hono's JSX handler prop middle (`dblclick` → `DoubleClick`). */
export const honoEventPropNames: Record<string, string> =
  eventPropNames("DoubleClick");

/** The Preact dialect. */
export const preactDialect: JsxDialect = {
  name: "Preact",
  jsxImportSource: "preact",
  attrTagModule: "@mxlang/preact",
  classAttr: "class",
  forAttr: "for",
  textareaContent: "children",
  textareaLeadingNewline: "ssr",
  rawHtmlProp: "dangerouslySetInnerHTML",
  rawHtmlValue: (code) => `{ __html: ${code} }`,
  errorBoundaryModule: "@mxlang/preact/runtime",
  errorBoundaryName: "MxErrorBoundary",
  suspenseName: "MxPlaceholder",
  fragmentModule: "preact",
  eventPropNames: preactEventPropNames,
  hookModules: ["preact/hooks", "preact/compat", "react"],
};
