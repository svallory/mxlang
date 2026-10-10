// Import the light subpaths, not the package root: the root is preact's
// compile entry, and a descriptor's dependencies must stay light
// (target-registry's light-import test).
import type { JsxDialect } from "@mxlang/host-preact/dialect";
import { createJsxDeclarations } from "@mxlang/host-preact/emitter";

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
 * This is react-dom's *runtime* table: what it binds, not what MX emits
 * ({@link reactEventPropNames} is that, from the types). Kept as data, not
 * code, so the drift test
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
 * DOM event name → the camelCase event name react-dom registers for it
 * (without the `on` prefix), built from {@link REACT_SIMPLE_EVENT_NAMES} plus everything react-dom
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
 * `change` is absent: react-dom's `ChangeEventPlugin` registers `onChange`
 * separately (binding `input` on text fields, the documented gotcha).
 *
 * The runtime side only: the drift test uses it to prove react-dom binds every
 * name in {@link reactEventPropNames}, which is what the emitter looks up.
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

/**
 * Every DOM handler prop `@types/react` declares (the middle of the prop:
 * `"KeyDown"` → `onKeyDown`), capture variants aside: the props of
 * `DOMAttributes` plus the element-specific `onCancel`/`onClose` (`<dialog>`)
 * and `onResize` (`<video>`). This, not react-dom's registration table, is
 * what MX may emit: react-dom also registers `onFullscreenChange` and
 * `onFullscreenError`, which the types reject (TS2322 under `mx-tsc`).
 * `src/event-names.test.ts` compares it both ways against the installed
 * `@types/react`, and checks that react-dom binds every name.
 */
export const REACT_DECLARED_EVENT_NAMES: readonly string[] = [
  "Abort",
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
  "CompositionEnd",
  "CompositionStart",
  "CompositionUpdate",
  "ContextMenu",
  "Copy",
  "Cut",
  "DoubleClick",
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
  "Error",
  "Focus",
  "GotPointerCapture",
  "Input",
  "Invalid",
  "KeyDown",
  "KeyPress",
  "KeyUp",
  "Load",
  "LoadedData",
  "LoadedMetadata",
  "LoadStart",
  "LostPointerCapture",
  "MouseDown",
  "MouseEnter",
  "MouseLeave",
  "MouseMove",
  "MouseOut",
  "MouseOver",
  "MouseUp",
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
  "Seeked",
  "Seeking",
  "Select",
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

/**
 * DOM event name → the middle of the React handler prop MX emits for it: one
 * entry per {@link REACT_DECLARED_EVENT_NAMES} name, keyed by its lowercase,
 * plus react-dom's three hand registrations keyed by the DOM event they bind
 * (`dblclick` → `DoubleClick`, `focusin` → `Focus`, `focusout` → `Blur`).
 * The authored React spelling `onDoubleClick` (`doubleclick`) therefore lands
 * on the declared `onDoubleClick`, as on hono. Closed: a DOM name outside it
 * is a compile error (`JsxDialect.closedEventPropNames`).
 */
export const reactEventPropNames: Record<string, string> = Object.assign(
  Object.fromEntries(
    REACT_DECLARED_EVENT_NAMES.map((name) => [name.toLowerCase(), name]),
  ),
  { dblclick: "DoubleClick", focusin: "Focus", focusout: "Blur" },
);

/** React vocabulary for the shared Preact/React JSX emitter. */
export const reactDialect: JsxDialect = {
  name: "React",
  jsxImportSource: "react",
  attrTagModule: "@mxlang/host-react",
  classAttr: "className",
  reactBooleanAttributes: true,
  forAttr: "htmlFor",
  textareaContent: "value",
  textareaLeadingNewline: "never",
  rawHtmlProp: "dangerouslySetInnerHTML",
  rawHtmlValue: (code) => `{ __html: ${code} }`,
  errorBoundaryModule: "@mxlang/host-react/runtime",
  errorBoundaryName: "MxErrorBoundary",
  suspenseName: "MxPlaceholder",
  fragmentModule: "react",
  // React's declared event-prop spellings, keyed by DOM event name — a
  // lookup, not a derivation (see reactEventPropNames). Closed: a DOM name
  // React's types declare no handler for is a compile error.
  eventPropNames: reactEventPropNames,
  closedEventPropNames: true,
  hookModules: ["react"],
};

/** Resolve-time policy shared structurally with Preact, with React diagnostics. */
export const reactDeclarations = createJsxDeclarations("React");

/** {@link reactDeclarations} for a `.react.mx` region: hook errors name the surrounding component. */
export const reactRegionDeclarations = createJsxDeclarations("React", {
  region: true,
});
