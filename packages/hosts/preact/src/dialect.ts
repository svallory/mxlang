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
   * when omitted; every shipped dialect's `/runtime` entry exports both.
   */
  mxClassModule?: string;
  /** Named export in that module: a component taking `fallback` and a body thunk. */
  errorBoundaryName: string;
  /** Named export in that module: the `<try>` placeholder/suspense wrapper. */
  suspenseName: string;
  /** Module the JSX `Fragment` is imported from, for an explicit import. */
  fragmentModule: string;
  /**
   * This dialect's event-prop names, keyed by DOM event name — the value is
   * the middle of the prop (`"KeyDown"` → `onKeyDown`), so the plain
   * `on` + capitalized-DOM-name recomposition is the fallback, not the
   * rule. The names are camelCase data no derivation can reverse
   * (`keydown` → `onKeyDown`, never `onKeydown`), so every built-in dialect
   * looks them up in a table holding exactly the handler props its JSX types
   * declare ({@link preactEventPropNames}, {@link honoEventPropNames}, and
   * `reactEventPropNames` in `@mxlang/react`'s `dialect.ts`).
   */
  eventPropNames?: Record<string, string>;
  /**
   * `true` when {@link eventPropNames} is the complete list of handler props
   * the dialect's JSX types declare: a DOM event name outside it is a compile
   * error rather than an `on` + capitalized guess the type-check would reject
   * and the runtime might never bind. All three built-in dialects (Preact,
   * React, hono) set it; a dialect without it keeps the capitalized
   * fallback.
   */
  closedEventPropNames?: boolean;
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
 * The camelCase spelling of every DOM event that both the Preact and the Hono
 * JSX types declare a handler prop for (the middle of the prop: `"KeyDown"` →
 * `onKeyDown`), less `dblclick`, which the two spell differently
 * (`onDblClick` / `onDoubleClick`; see {@link preactEventPropNames} and
 * {@link honoEventPropNames}).
 *
 * The shared emitter recomposes a handler prop from the DOM event name core
 * resolved. Without this lookup `keydown` became `onKeydown`, which neither
 * type set declares (TS2322 on valid code under `mx-tsc`, decision 161).
 * Preact (it lowercases `onKeydown` to find the DOM property) and hono's DOM
 * renderer both still bound the old spelling at run time, so the bug was in
 * the type-check only; the names are still data to look up, not a rule to
 * derive. Each dialect's table holds only the names its own JSX types declare:
 * `src/event-names.test.ts` compares both directions against the installed
 * type files.
 */
const SHARED_EVENT_NAMES: readonly string[] = [
  "AnimationEnd",
  "AnimationIteration",
  "AnimationStart",
  "AuxClick",
  "BeforeInput",
  "Blur",
  "Change",
  "Click",
  "CompositionEnd",
  "CompositionStart",
  "CompositionUpdate",
  "ContextMenu",
  "Copy",
  "Cut",
  "Error",
  "Focus",
  "FocusIn",
  "FocusOut",
  "FormData",
  "GotPointerCapture",
  "Input",
  "Invalid",
  "KeyDown",
  "KeyPress",
  "KeyUp",
  "Load",
  "LostPointerCapture",
  "MouseDown",
  "MouseEnter",
  "MouseLeave",
  "MouseMove",
  "MouseOut",
  "MouseOver",
  "MouseUp",
  "Paste",
  "PointerCancel",
  "PointerDown",
  "PointerEnter",
  "PointerLeave",
  "PointerMove",
  "PointerOut",
  "PointerOver",
  "PointerUp",
  "Reset",
  "Scroll",
  "ScrollEnd",
  "Select",
  "Submit",
  "TouchCancel",
  "TouchEnd",
  "TouchMove",
  "TouchStart",
  "TransitionCancel",
  "TransitionEnd",
  "TransitionRun",
  "TransitionStart",
  "Wheel",
];

/** Handler props only `preact`'s `jsx.d.ts` declares. */
const PREACT_ONLY_EVENT_NAMES: readonly string[] = [
  "Abort",
  "BeforeToggle",
  "Cancel",
  "CanPlay",
  "CanPlayThrough",
  "Close",
  "Command",
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
  "LeavePictureInPicture",
  "LoadedData",
  "LoadedMetadata",
  "LoadStart",
  "Pause",
  "Play",
  "Playing",
  "Progress",
  "RateChange",
  "Resize",
  "ScrollSnapChange",
  "ScrollSnapChanging",
  "Search",
  "Seeked",
  "Seeking",
  "Stalled",
  "Suspend",
  "TimeUpdate",
  "Toggle",
  "VolumeChange",
  "Waiting",
];

/** Handler props only `hono/jsx`'s intrinsic elements declare. */
const HONO_ONLY_EVENT_NAMES: readonly string[] = [
  "AnimationCancel",
  "FullscreenChange",
  "FullscreenError",
  "MouseWheel",
  "SelectChange",
];

function eventPropNames(
  dblclick: string,
  only: readonly string[],
  doubleclick?: string,
): Record<string, string> {
  const names: Record<string, string> = { dblclick };
  if (doubleclick !== undefined) names.doubleclick = doubleclick;
  for (const name of [...SHARED_EVENT_NAMES, ...only]) {
    names[name.toLowerCase()] = name;
  }
  return names;
}

/** DOM event name → Preact's JSX handler prop middle (`dblclick` → `DblClick`). */
export const preactEventPropNames: Record<string, string> = eventPropNames(
  "DblClick",
  PREACT_ONLY_EVENT_NAMES,
);

/**
 * DOM event name → Hono's JSX handler prop middle (`dblclick` →
 * `DoubleClick`). Hono declares `onDoubleClick` as written, so the authored
 * React spelling (`doubleclick`) lands on the same prop.
 */
export const honoEventPropNames: Record<string, string> = eventPropNames(
  "DoubleClick",
  HONO_ONLY_EVENT_NAMES,
  "DoubleClick",
);

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
  closedEventPropNames: true,
  hookModules: ["preact/hooks", "preact/compat", "react"],
};
