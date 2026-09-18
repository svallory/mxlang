/**
 * React's event-prop names are vendored data (see `target.ts`), not a rule
 * anyone can derive — `keydown` is `onKeyDown`, never `onKeydown`. Two
 * things are pinned here:
 *
 * - a table test driving the real emitter with one row per vendored name,
 *   so a hand-edited list cannot drift from what MX actually emits;
 * - a drift test comparing the vendored list against the installed
 *   react-dom's own `simpleEventPluginEvents` source, so a react-dom pin
 *   bump cannot silently change React's names out from under the vendor.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";
import {
  buildReactEventPropNames,
  REACT_SIMPLE_EVENT_NAMES,
} from "./target.ts";

const require = createRequire(import.meta.url);

/** The body of the emitted component's `return (…)`, without the wrapper. */
function markup(source: string): string {
  const code = compileReactMx(source, "/fixtures/test.mx").code;
  const match = code.match(/return \(<>([\s\S]*)<\/>\);/);
  if (!match) throw new Error("compiled module has no JSX return body");
  return match[1] as string;
}

describe("vendored React event names", () => {
  const propNames = buildReactEventPropNames();

  it("covers every vendored simple name: domName -> on + React's camelCase", () => {
    for (const reactName of REACT_SIMPLE_EVENT_NAMES) {
      const domName = reactName.toLowerCase();
      const capitalized =
        reactName.charAt(0).toUpperCase() + reactName.slice(1);
      expect(propNames[domName], domName).toBe(capitalized);
    }
  });

  it("includes the registrations outside the simple loop", () => {
    for (const [domName, reactName] of Object.entries({
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
      animationend: "AnimationEnd",
      animationiteration: "AnimationIteration",
      animationstart: "AnimationStart",
      transitionrun: "TransitionRun",
      transitionstart: "TransitionStart",
      transitioncancel: "TransitionCancel",
      transitionend: "TransitionEnd",
    })) {
      expect(propNames[domName], domName).toBe(reactName);
    }
  });

  it("does not treat onChange as an ordinary rename (its semantics are the gotcha)", () => {
    expect("change" in propNames).toBe(false);
    // …but the emitted prop is still onChange, through the shared fallback.
    expect(markup("<input onChange=handler>")).toBe(
      "<input onChange={handler} />",
    );
  });

  it("emits React's camelCase prop for multi-word DOM names", () => {
    expect(markup("<input onKeyDown=handler>")).toBe(
      "<input onKeyDown={handler} />",
    );
    expect(markup("<div onMouseDown=f>x</div>")).toBe(
      "<div onMouseDown={f}>x</div>",
    );
    expect(markup("<div onPointerDown=f>x</div>")).toBe(
      "<div onPointerDown={f}>x</div>",
    );
    expect(markup("<div onTouchStart=f>x</div>")).toBe(
      "<div onTouchStart={f}>x</div>",
    );
    expect(markup("<div on-dblclick=f>x</div>")).toBe(
      "<div onDoubleClick={f}>x</div>",
    );
    expect(markup("<input onFocusIn=handler>")).toBe(
      "<input onFocus={handler} />",
    );
    expect(markup("<input on-timeupdate=handler>")).toBe(
      "<input onTimeUpdate={handler} />",
    );
  });

  it("matches React's table against the installed react-dom (drift test)", () => {
    let bundlePath: string;
    try {
      bundlePath = require.resolve(
        "react-dom/cjs/react-dom-client.development.js",
      );
    } catch {
      bundlePath = "";
    }
    if (!bundlePath || !existsSync(bundlePath)) {
      // No react-dom resolvable: the vendored list stands alone.
      return;
    }
    const source = readFileSync(bundlePath, "utf8");
    const listMatch = source.match(
      /simpleEventPluginEvents\s*=\s*"([^"]+)"\.split\(/,
    );
    const pushMatch = source.match(
      /simpleEventPluginEvents\.push\("([^"]+)"\)/,
    );
    expect(
      listMatch,
      "simpleEventPluginEvents list in react-dom source",
    ).toBeTruthy();
    const fromSource = (listMatch?.[1] ?? "").split(" ");
    if (pushMatch) fromSource.push(pushMatch[1] as string);
    expect([...REACT_SIMPLE_EVENT_NAMES].sort()).toEqual(fromSource.sort());
  });
});
