import { createJsxDeclarations, type Target } from "@mxlang/preact";

/**
 * React's own event-prop names, vendored from its registration table.
 *
 * Source: `node_modules/react-dom/cjs/react-dom-client.development.js`
 * (`simpleEventPluginEvents`, ~line 28109, react-dom 19.3.0) plus the
 * registrations outside that loop (~lines 30089-30139). React's table is a
 * camelCase list that react-dom lowercases to get each DOM event name, so
 * there is no derivation an author (or MX) can apply in reverse: `keydown`
 * is `onKeyDown`, not `onKeydown`; `timeupdate` is `onTimeUpdate`. The DOM
 * name MX resolved is the *input*, and React's spelling is a *lookup* in
 * this list — that is the whole rule.
 *
 * Kept as data, not code, so the drift test
 * (`src/event-names.test.ts`) can compare it against the installed
 * react-dom and a pin bump cannot silently change React's names.
 */
export const REACT_SIMPLE_EVENT_NAMES: readonly string[] = [
  "abort",
  "auxClick",
  "beforeToggle",
  "cancel",
  "canPlay",
  "canPlayThrough",
  "click",
  "close",
  "contextMenu",
  "copy",
  "cut",
  "drag",
  "dragEnd",
  "dragEnter",
  "dragExit",
  "dragLeave",
  "dragOver",
  "dragStart",
  "drop",
  "durationChange",
  "emptied",
  "encrypted",
  "ended",
  "error",
  "fullscreenChange",
  "fullscreenError",
  "gotPointerCapture",
  "input",
  "invalid",
  "keyDown",
  "keyPress",
  "keyUp",
  "load",
  "loadedData",
  "loadedMetadata",
  "loadStart",
  "lostPointerCapture",
  "mouseDown",
  "mouseMove",
  "mouseOut",
  "mouseOver",
  "mouseUp",
  "paste",
  "pause",
  "play",
  "playing",
  "pointerCancel",
  "pointerDown",
  "pointerMove",
  "pointerOut",
  "pointerOver",
  "pointerUp",
  "progress",
  "rateChange",
  "reset",
  "resize",
  "seeked",
  "seeking",
  "stalled",
  "submit",
  "suspend",
  "timeUpdate",
  "touchCancel",
  "touchEnd",
  "touchStart",
  "volumeChange",
  "scroll",
  "toggle",
  "touchMove",
  "waiting",
  "wheel",
  // `simpleEventPluginEvents.push("scrollEnd")` in the source.
  "scrollEnd",
];

/**
 * DOM event name → React's camelCase event name (without the `on` prefix),
 * built from {@link REACT_SIMPLE_EVENT_NAMES} plus everything react-dom
 * registers outside that loop:
 *
 * - the vendor-prefixed animation/transition events, keyed by their
 *   unprefixed modern DOM names (`animationend` → `AnimationEnd`, …);
 * - the three specials react-dom registers by hand (`dblclick` →
 *   `DoubleClick`, `focusin` → `Focus`, `focusout` → `Blur`);
 * - the direct/two-phase plain renames not in the simple list
 *   (`mouseenter` → `MouseEnter`, `beforeinput` → `BeforeInput`,
 *   `compositionstart` → `CompositionStart`, `select` → `Select`, …).
 *
 * `change` is deliberately absent: the shared emitter's plain recomposition
 * already yields `onChange`, and React's `onChange` semantics (binds `input`
 * on text fields) are the documented gotcha, not a name MX should treat as
 * an ordinary rename.
 */
export function buildReactEventPropNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const reactName of REACT_SIMPLE_EVENT_NAMES) {
    // The list is lowercase-first camel (`keyDown`); the prop's middle is
    // capitalized (`KeyDown` → `onKeyDown`), matching what react-dom's
    // registration loop does with each entry.
    names[reactName.toLowerCase()] =
      reactName.charAt(0).toUpperCase() + reactName.slice(1);
  }
  Object.assign(names, {
    animationend: "AnimationEnd",
    animationiteration: "AnimationIteration",
    animationstart: "AnimationStart",
    transitionrun: "TransitionRun",
    transitionstart: "TransitionStart",
    transitioncancel: "TransitionCancel",
    transitionend: "TransitionEnd",
    dblclick: "DoubleClick",
    focusin: "Focus",
    focusout: "Blur",
    mouseenter: "MouseEnter",
    mouseleave: "MouseLeave",
    pointerenter: "PointerEnter",
    pointerleave: "PointerLeave",
    beforeinput: "BeforeInput",
    compositionstart: "CompositionStart",
    compositionend: "CompositionEnd",
    compositionupdate: "CompositionUpdate",
    select: "Select",
  });
  return names;
}

/** React vocabulary for the shared Preact/React JSX emitter. */
export const reactTarget: Target = {
  name: "React",
  jsxImportSource: "react",
  classAttr: "className",
  forAttr: "htmlFor",
  rawHtmlProp: "dangerouslySetInnerHTML",
  rawHtmlValue: (code) => `{ __html: ${code} }`,
  errorBoundaryModule: "@mxlang/react/runtime",
  errorBoundaryName: "MxErrorBoundary",
  suspenseName: "MxPlaceholder",
  fragmentModule: "react",
  // React's own event-prop spellings, keyed by DOM event name — a lookup,
  // not a derivation (see buildReactEventPropNames). Anything not in the
  // map falls back to the shared emitter's `on` + capitalized-DOM-name
  // recomposition, which React tolerates for the names it does not know.
  eventPropNames: buildReactEventPropNames(),
};

/** Resolve-time policy shared structurally with Preact, with React diagnostics. */
export const reactDeclarations = createJsxDeclarations("React");
