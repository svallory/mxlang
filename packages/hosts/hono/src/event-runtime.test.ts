/**
 * hono's emitted handler props use the names its JSX types declare
 * (`onKeyDown`, `onDoubleClick`; decision 161), and `hono/jsx/dom` must still
 * bind them to the DOM events. The old `onKeydown`/`onDblclick` spellings bound
 * too (the renderer lowercases the name), so this is a regression guard.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const EVENTS = ["keydown", "keyup", "mousedown", "dblclick"] as const;
let scratch = "";
let componentFile = "";

const CLIENT = (file: string) => `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body><div id=r></div></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
const { render } = await import("hono/jsx/dom");
const { jsx } = await import("hono/jsx");
const mod = await import(${JSON.stringify(file)});
const fired = [];
globalThis.__fired = fired;
const root = document.getElementById("r");
render(jsx(mod.default, {}), root);
for (const name of ${JSON.stringify(EVENTS)}) {
  const Ctor = name.startsWith("key") ? dom.window.KeyboardEvent : dom.window.MouseEvent;
  root.querySelector("[data-e='" + name + "']").dispatchEvent(new Ctor(name, { bubbles: true }));
}
console.log(JSON.stringify(fired));
`;

beforeAll(() => {
  // Under the OS temp dir, not the package root (a killed run would leave
  // untracked files in the worktree); the package's `node_modules` is linked in
  // so `hono` and `jsdom` still resolve from the scratch files.
  scratch = mkdtempSync(join(tmpdir(), "mx-event-runtime-"));
  symlinkSync(join(packageDir, "node_modules"), join(scratch, "node_modules"));
  componentFile = join(scratch, "case.tsx");
  const source = EVENTS.map(
    (event) =>
      `<div data-e="${event}" on-${event}=(() => globalThis.__fired.push("${event}"))>x</div>`,
  ).join("\n");
  writeFileSync(componentFile, compileHonoMx(source, componentFile).code);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the emitted handler props fire (hono)", () => {
  it("emits the declared spellings", () => {
    const code = compileHonoMx(
      "<div on-keydown=a on-dblclick=b on-mousedown=c>x</div>",
      "/fixtures/test.mx",
    ).code;
    expect(code).toContain("onKeyDown={a}");
    expect(code).toContain("onDoubleClick={b}");
    expect(code).toContain("onMouseDown={c}");
  });

  it("emits onDoubleClick as declared and rejects names hono does not declare", () => {
    expect(
      compileHonoMx("<button onDoubleClick=f>x</button>", "/fixtures/test.mx")
        .code,
    ).toContain("onDoubleClick={f}");
    for (const attr of ["on-toggle", "on-search", "on-play"]) {
      expect(() =>
        compileHonoMx(`<div ${attr}=f>x</div>`, "/fixtures/test.mx"),
      ).toThrow("JSX types declare no handler prop for");
    }
  });

  it("binds keydown, keyup, mousedown and dblclick through hono/jsx/dom", () => {
    const entry = join(scratch, "run.mjs");
    writeFileSync(entry, CLIENT(componentFile));
    const fired = JSON.parse(
      execFileSync("bun", [entry], { encoding: "utf8", cwd: scratch }),
    );
    expect(fired).toEqual([...EVENTS]);
  }, 30_000);
});
