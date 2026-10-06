/**
 * React's event-prop names are vendored data (see `dialect.ts`), not a rule
 * anyone can derive — `keydown` is `onKeyDown`, never `onKeydown`. Two
 * things are pinned here:
 *
 * - a table test driving the real emitter with one row per vendored name,
 *   so a hand-edited list cannot drift from what MX actually emits;
 * - a drift test comparing the vendored list against the installed
 *   react-dom's own `simpleEventPluginEvents` source, so a react-dom pin
 *   bump cannot silently change React's names out from under the vendor;
 * - the emitted table (`reactEventPropNames`) against the installed
 *   `@types/react`, both ways, and against react-dom's registrations, so MX
 *   emits only names the types declare and react-dom binds; any other DOM
 *   name is a compile error;
 * - a render that fires real events at the emitted props.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildReactEventPropNames,
  REACT_DECLARED_EVENT_NAMES,
  REACT_SIMPLE_EVENT_NAMES,
  reactEventPropNames,
} from "./dialect.ts";
import { compileReactMx } from "./index.ts";

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

  it("leaves change to react-dom's ChangeEventPlugin, outside the simple table", () => {
    expect("change" in propNames).toBe(false);
    // …and the emitted prop is still onChange, which the types declare.
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
    let packageJson = "";
    try {
      // The bundle itself is not an exported subpath; resolve the package
      // root and reach the development bundle on disk.
      packageJson = require.resolve("react-dom/package.json");
    } catch {
      packageJson = "";
    }
    // A disarmed guard must fail loudly: the vendored list is only
    // trustworthy while it is checked against react-dom itself, so a
    // missing package is an assertion failure, not a skip.
    expect(packageJson).toBeTruthy();
    const bundlePath = join(
      dirname(packageJson),
      "cjs/react-dom-client.development.js",
    );
    expect(existsSync(bundlePath)).toBe(true);
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

/**
 * Every DOM handler prop `@types/react` declares, capture variants aside. The
 * DOM handlers are the props typed `…EventHandler<T>` (that excludes
 * `<ViewTransition>`'s `onEnter`/`onExit`/`onShare`/`onUpdate` and
 * `<Profiler>`'s `onRender`); a name ending in `Capture` is a capture variant
 * only when its base is declared too (`onGotPointerCapture` is an event).
 */
function declaredReactHandlers(): Set<string> {
  const file = join(
    dirname(require.resolve("@types/react/package.json")),
    "index.d.ts",
  );
  const names = new Set<string>();
  for (const match of readFileSync(file, "utf8").matchAll(
    /^\s+(on[A-Z][A-Za-z]*)\?: [A-Za-z]*EventHandler<T\b/gm,
  )) {
    names.add(match[1] as string);
  }
  return new Set(
    [...names].filter(
      (name) => !(name.endsWith("Capture") && names.has(name.slice(0, -7))),
    ),
  );
}

describe("React's emitted names are the ones @types/react declares", () => {
  const declared = declaredReactHandlers();

  it("lists every declared handler (types → table)", () => {
    expect(declared.size).toBeGreaterThan(80);
    expect(
      [...REACT_DECLARED_EVENT_NAMES].map((name) => `on${name}`).sort(),
    ).toEqual([...declared].sort());
  });

  it("emits no name the types do not declare (table → types)", () => {
    for (const [dom, middle] of Object.entries(reactEventPropNames)) {
      expect(declared.has(`on${middle}`), `${dom} → on${middle}`).toBe(true);
    }
  });

  it("emits only names react-dom binds", () => {
    // `onChange` is ChangeEventPlugin's, outside the registration table.
    const bound = new Set([
      ...Object.values(buildReactEventPropNames()),
      "Change",
    ]);
    for (const middle of Object.values(reactEventPropNames)) {
      expect(bound.has(middle), `on${middle}`).toBe(true);
    }
  });

  it("leaves out what react-dom registers but the types reject", () => {
    expect(buildReactEventPropNames().fullscreenchange).toBe(
      "FullscreenChange",
    );
    expect(reactEventPropNames.fullscreenchange).toBeUndefined();
    expect(reactEventPropNames.fullscreenerror).toBeUndefined();
  });

  it("keys react-dom's hand registrations by the DOM event they bind", () => {
    expect(reactEventPropNames.dblclick).toBe("DoubleClick");
    expect(reactEventPropNames.focusin).toBe("Focus");
    expect(reactEventPropNames.focusout).toBe("Blur");
    // The authored React spellings resolve to the same declared props.
    expect(reactEventPropNames.doubleclick).toBe("DoubleClick");
    expect(reactEventPropNames.focus).toBe("Focus");
    expect(reactEventPropNames.blur).toBe("Blur");
  });

  it("maps the pointer-capture events, which are not capture variants", () => {
    expect(reactEventPropNames.gotpointercapture).toBe("GotPointerCapture");
    expect(reactEventPropNames.lostpointercapture).toBe("LostPointerCapture");
  });
});

describe("authored spellings on React", () => {
  it.each([
    ["onDoubleClick", "onDoubleClick"],
    ["onDblClick", "onDoubleClick"],
    ["on-dblclick", "onDoubleClick"],
    ["onFocus", "onFocus"],
    ["onFocusIn", "onFocus"],
    ["onBlur", "onBlur"],
    ["on-gotpointercapture", "onGotPointerCapture"],
    ["on-toggle", "onToggle"],
  ])("%s emits %s", (attr, prop) => {
    expect(markup(`<div ${attr}=f>x</div>`)).toBe(`<div ${prop}={f}>x</div>`);
  });

  it.each([
    ["on-fullscreenchange", "fullscreenchange"],
    ["on-gesturestart", "gesturestart"],
    ["on-search", "search"],
    ["onMouseWheel", "mousewheel"],
  ])("%s, which the types do not declare, fails the compile", (attr, event) => {
    expect(() => markup(`<div ${attr}=f>x</div>`)).toThrow(
      `\`${attr}\` names the DOM event \`${event}\`, which React's JSX types declare no handler prop for`,
    );
  });
});

const packageDir = fileURLToPath(new URL("..", import.meta.url));
let scratch = "";

/** Each row: the authored attribute, and the DOM event dispatched at it. */
const FIRED = [
  ["on-keydown", "keydown"],
  ["on-keyup", "keyup"],
  ["on-mousedown", "mousedown"],
  ["on-dblclick", "dblclick"],
  ["onDoubleClick", "dblclick"],
  ["onFocusIn", "focusin"],
] as const;

const CLIENT = `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const mod = await import("./case.tsx");
const host = document.createElement("div");
document.body.append(host);
flushSync(() => createRoot(host).render(React.createElement(mod.default, {})));
const fired = [];
globalThis.__fired = fired;
for (const [index, name] of ${JSON.stringify(FIRED.map(([, event]) => event))}.entries()) {
  const Ctor = name.startsWith("key")
    ? dom.window.KeyboardEvent
    : name.startsWith("focus")
      ? dom.window.FocusEvent
      : dom.window.MouseEvent;
  host.querySelector("[data-i='" + index + "']").dispatchEvent(new Ctor(name, { bubbles: true }));
}
console.log(JSON.stringify(fired));
`;

beforeAll(() => {
  // Under the OS temp dir, not the package root (a killed run would leave
  // untracked files in the worktree); the package's `node_modules` is linked
  // in so `react`, `react-dom` and `jsdom` resolve from the scratch files.
  scratch = mkdtempSync(join(tmpdir(), "mx-react-events-"));
  symlinkSync(join(packageDir, "node_modules"), join(scratch, "node_modules"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the emitted handler props fire (React)", () => {
  it("binds each authored spelling to its DOM event through react-dom", () => {
    const file = join(scratch, "case.tsx");
    const source = FIRED.map(
      ([attr], index) =>
        `<div data-i="${index}" ${attr}=(() => globalThis.__fired.push("${attr}"))>x</div>`,
    ).join("\n");
    writeFileSync(file, compileReactMx(source, file).code);
    writeFileSync(join(scratch, "run.mjs"), CLIENT);
    const fired = JSON.parse(
      execFileSync("bun", ["run.mjs"], { encoding: "utf8", cwd: scratch }),
    );
    expect(fired).toEqual(FIRED.map(([attr]) => attr));
  }, 30_000);
});
