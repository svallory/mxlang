/**
 * Solid 2's own event-prop names, vendored from `@solidjs/web`'s JSX types.
 *
 * Source: `node_modules/@solidjs/web/types/jsx.d.ts` (every `on<Name>?:`
 * declaration, `@solidjs/web` 2.0.0-rc.7). Solid's runtime lowercases
 * whatever follows `on` (`prop.slice(2).toLowerCase()`,
 * `@solidjs/web/dist/web.dev.js`), so any casing binds the same DOM event —
 * this table is not a derivation an author or MX could get from the DOM name
 * alone, it is *what Solid's own types declare*, needed only so the
 * type-checked TSX matches those types. Recomposing `on` + capitalize-first
 * of the DOM name (`onDblclick`, `onKeydown`) is byte-different from Solid's
 * declared spelling (`onDblClick`, `onKeyDown`) on 97 of these 143 names, and
 * a byte-different prop name is what `jsx.d.ts`'s exact string keys reject
 * (TS2322).
 *
 * Kept as data, not code, so the drift test (`event-names.test.ts`) can
 * compare it against the installed `@solidjs/web` and a pin bump cannot
 * silently change Solid's names out from under the vendor.
 */
export const SOLID_EVENT_PROP_NAMES: readonly string[] = [
  "Abort",
  "AfterPrint",
  "AnimationCancel",
  "AnimationEnd",
  "AnimationIteration",
  "AnimationStart",
  "AuxClick",
  "BeforeCopy",
  "BeforeCut",
  "BeforeInput",
  "BeforeMatch",
  "BeforePaste",
  "BeforePrint",
  "BeforeToggle",
  "BeforeUnload",
  "BeforeXRSelect",
  "Begin",
  "Blur",
  "CanPlay",
  "CanPlayThrough",
  "Cancel",
  "Change",
  "Click",
  "Close",
  "Command",
  "CompositionEnd",
  "CompositionStart",
  "CompositionUpdate",
  "ContentVisibilityAutoStateChange",
  "ContextLost",
  "ContextMenu",
  "ContextRestored",
  "Copy",
  "CueChange",
  "Cut",
  "DblClick",
  "DeviceMotion",
  "DeviceOrientation",
  "DeviceOrientationAbsolute",
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
  "End",
  "Ended",
  "EnterPictureInPicture",
  "Error",
  "Focus",
  "FocusIn",
  "FocusOut",
  "FormData",
  "FullscreenChange",
  "FullscreenError",
  "GamepadConnected",
  "GamepadDisconnected",
  "GotPointerCapture",
  "Hashchange",
  "Input",
  "Invalid",
  "KeyDown",
  "KeyPress",
  "KeyUp",
  "LanguageChange",
  "LeavePictureInPicture",
  "Load",
  "LoadStart",
  "LoadedData",
  "LoadedMetadata",
  "LostPointerCapture",
  "Message",
  "MessageError",
  "MouseDown",
  "MouseEnter",
  "MouseLeave",
  "MouseMove",
  "MouseOut",
  "MouseOver",
  "MouseUp",
  "Offline",
  "Online",
  "OrientationChange",
  "PageHide",
  "PageReveal",
  "PageShow",
  "PageSwap",
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
  "PointerRawUpdate",
  "PointerUp",
  "Popstate",
  "Progress",
  "RateChange",
  "RejectionHandled",
  "Repeat",
  "Reset",
  "Resize",
  "Scroll",
  "ScrollEnd",
  "ScrollSnapChange",
  "ScrollSnapChanging",
  "SecurityPolicyViolation",
  "Seeked",
  "Seeking",
  "Select",
  "SelectStart",
  "SelectionChange",
  "SlotChange",
  "Stalled",
  "Storage",
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
  "UnhandledRejection",
  "Unload",
  "VolumeChange",
  "Waiting",
  "WaitingForKey",
  "Wheel",
];

/**
 * Builds a DOM event name (lowercase) -> Solid JSX prop-name-suffix lookup
 * from the vendored list above.
 */
export function buildSolidEventPropNames(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of SOLID_EVENT_PROP_NAMES) {
    map[name.toLowerCase()] = name;
  }
  return map;
}

const SOLID_EVENT_PROP_NAME_BY_DOM_NAME = buildSolidEventPropNames();

/**
 * Recomposes Solid's own JSX prop name for a resolved DOM event name
 * (decision 101's Phase B, corrected): the vendored `jsx.d.ts` spelling when
 * `@solidjs/web` declares one, else `on` + capitalize-first, for a DOM event
 * Solid's types don't enumerate. Solid's runtime lowercases either spelling
 * identically, so this changes only what TypeScript sees, never what binds.
 */
export function solidEventPropName(domEventName: string): string {
  const declared = SOLID_EVENT_PROP_NAME_BY_DOM_NAME[domEventName];
  if (declared !== undefined) return `on${declared}`;
  return `on${domEventName.charAt(0).toUpperCase()}${domEventName.slice(1)}`;
}
