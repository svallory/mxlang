/**
 * Preact's and hono's handler props are the camelCase names their JSX types
 * declare (`onKeyDown`, never the recomposed `onKeydown`): the type-check
 * rejects any other spelling (decision 161). Three things are pinned:
 *
 * - drift: every handler prop the installed `preact` and `hono/jsx` types
 *   declare is what the dialect tables produce from its lowercased name;
 * - emission: the shared emitter writes those spellings for both dialects;
 * - runtime: the emitted prop fires its handler in a real render. The old
 *   spelling fired too (both runtimes lowercase the name at bind time), so
 *   this is a regression guard, not a bug witness.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { honoEventPropNames, preactEventPropNames } from "./dialect.ts";
import { compilePreactMx } from "./index.ts";

const require = createRequire(import.meta.url);
const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** Every non-capture `on…` prop name declared in a types file. */
function declaredHandlers(file: string): string[] {
  const names = new Set<string>();
  for (const match of readFileSync(file, "utf8").matchAll(
    /^\s+(on[A-Za-z]+)\??:/gm,
  )) {
    const name = match[1] as string;
    if (!name.endsWith("Capture")) names.add(name);
  }
  return [...names];
}

const preactTypes = join(
  dirname(require.resolve("preact/package.json")),
  "src",
  "jsx.d.ts",
);
const honoTypes = join(
  dirname(require.resolve("hono/package.json")),
  "dist",
  "types",
  "jsx",
  "intrinsic-elements.d.ts",
);

describe.each([
  { host: "Preact", table: preactEventPropNames, types: preactTypes },
  { host: "hono", table: honoEventPropNames, types: honoTypes },
])(
  "$host event-prop names match the installed JSX types",
  ({ table, types }) => {
    it("maps every declared handler's lowercased DOM name back to its spelling", () => {
      const declared = declaredHandlers(types);
      expect(declared.length).toBeGreaterThan(50);
      for (const name of declared) {
        const dom = name.slice(2).toLowerCase();
        expect(`on${table[dom]}`, `${dom} → ${name}`).toBe(name);
      }
    });
  },
);

describe("spellings the two hosts disagree on", () => {
  it("dblclick is onDblClick on Preact and onDoubleClick on hono", () => {
    expect(preactEventPropNames.dblclick).toBe("DblClick");
    expect(honoEventPropNames.dblclick).toBe("DoubleClick");
  });
});

function markup(source: string): string {
  const code = compilePreactMx(source, "/fixtures/test.mx").code;
  const match = code.match(/return \(<>([\s\S]*)<\/>\);/);
  if (!match) throw new Error("compiled module has no JSX return body");
  return match[1] as string;
}

describe("emitted spellings (Preact)", () => {
  it.each([
    ["keydown", "onKeyDown"],
    ["keyup", "onKeyUp"],
    ["mousedown", "onMouseDown"],
    ["mouseup", "onMouseUp"],
    ["mouseenter", "onMouseEnter"],
    ["pointerdown", "onPointerDown"],
    ["touchstart", "onTouchStart"],
    ["contextmenu", "onContextMenu"],
    ["dblclick", "onDblClick"],
    ["focusin", "onFocusIn"],
    ["click", "onClick"],
    ["input", "onInput"],
  ])("on-%s emits %s", (dom, prop) => {
    expect(markup(`<div on-${dom}=f>x</div>`)).toBe(`<div ${prop}={f}>x</div>`);
  });
});

let scratch = "";
let componentFile = "";

const CLIENT = (file: string, events: string) => `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
const { h, render } = await import("preact");
const mod = await import(${JSON.stringify(file)});
const root = document.createElement("div");
document.body.append(root);
render(h(mod.default, {}), root);
const fired = [];
globalThis.__fired = fired;
for (const name of ${events}) {
  const Ctor = name.startsWith("key") ? dom.window.KeyboardEvent : dom.window.MouseEvent;
  root.querySelector("[data-e='" + name + "']").dispatchEvent(new Ctor(name, { bubbles: true }));
}
console.log(JSON.stringify(fired));
`;

const EVENTS = ["keydown", "keyup", "mousedown", "dblclick"] as const;

beforeAll(() => {
  scratch = mkdtempSync(join(packageDir, ".event-names-"));
  componentFile = join(scratch, "case.tsx");
  const source = EVENTS.map(
    (event) =>
      `<div data-e="${event}" on-${event}=(() => globalThis.__fired.push("${event}"))>x</div>`,
  ).join("\n");
  writeFileSync(componentFile, compilePreactMx(source, componentFile).code);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the emitted handler props fire (Preact)", () => {
  it("binds keydown, keyup, mousedown and dblclick under their declared spellings", () => {
    const entry = join(scratch, "run.mjs");
    writeFileSync(entry, CLIENT(componentFile, JSON.stringify(EVENTS)));
    const fired = JSON.parse(
      execFileSync("bun", [entry], { encoding: "utf8", cwd: scratch }),
    );
    expect(fired).toEqual([...EVENTS]);
  }, 30_000);
});
