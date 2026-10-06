import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import { parseExpression } from "@babel/parser";
import typescriptPreset from "@babel/preset-typescript";
import { sourceBindings, unknownSourceBindings } from "@mxlang/parser";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { beforeAll, describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

/**
 * A method attribute (`onClick() { … }`) becomes an arrow function. The arrow
 * is built from the parsed function's own positions, so a body holding its
 * own `) {` (an `if`, a `for`, an inner function) keeps its shape. A regex
 * over the printed function split at the last `) {` and emitted
 * `() { if (c) => { … } }`, which is not JavaScript.
 */
const BUTTONS: Record<string, string> = {
  ifBlock: "onClick() { if (input.on) { hit(1) } }",
  forBlock: "onClick() { for (const n of [2, 3]) { hit(n) } }",
  innerFunction:
    "onClick() { const add = function (n: number) { hit(n) }; add(4) }",
  innerArrow: "onClick(e: Event) { [5].forEach((n) => { if (e) { hit(n) } }) }",
  semicolons: "onClick() { if (input.on) { hit(6); } }",
};

const SETUP =
  "(globalThis as any).__mxHits = []; const hit = (n: number) => (globalThis as any).__mxHits.push(n); const input = { on: true };";

function fragment(): string {
  return `<div>${Object.entries(BUTTONS)
    .map(([id, method]) => `<button id="${id}" ${method}>${id}</button>`)
    .join("")}</div>`;
}

function compile(): string {
  const { code } = compileSolidMx(fragment(), {
    filename: "fixture.solid.mx",
    moduleBindings: sourceBindings(SETUP).bindings,
    unknownModuleBindings: unknownSourceBindings(SETUP),
  });
  return code;
}

let clicks: Record<string, number[]> = {};

beforeAll(() => {
  const source = `export function App() {\n  ${SETUP}\n  return ${compile()};\n}\n`;
  const out = transformSync(source, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "dom", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error("no output");
  const dir = mkdtempSync(join(packageRoot, ".method-attr-tmp-"));
  try {
    writeFileSync(join(dir, "app.mjs"), out.code);
    writeFileSync(
      join(dir, "run.mjs"),
      [
        'import { JSDOM } from "jsdom";',
        'const dom = new JSDOM("<!DOCTYPE html><body></body>");',
        "for (const k of ['window','document','HTMLElement','Node','Text','Comment','DocumentFragment']) globalThis[k] = dom.window[k];",
        'const { render } = await import("@solidjs/web");',
        'const { App } = await import("./app.mjs");',
        'const c = document.createElement("div");',
        "document.body.appendChild(c);",
        "render(() => App(), c);",
        "await new Promise((r) => setTimeout(r, 0));",
        "const out = {};",
        'for (const button of c.querySelectorAll("button")) {',
        "  globalThis.__mxHits = [];",
        '  button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));',
        "  out[button.id] = globalThis.__mxHits;",
        "}",
        "process.stdout.write(JSON.stringify(out));",
      ].join("\n"),
    );
    clicks = JSON.parse(
      execFileSync(
        "bun",
        ["run", "--conditions=browser", join(dir, "run.mjs")],
        {
          cwd: packageRoot,
          encoding: "utf8",
          timeout: 30_000,
        },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

describe("method attribute with nested blocks", () => {
  it("emits every handler as a parseable arrow with its whole body", () => {
    const code = compile();
    expect(code).not.toMatch(/\)\s*=>\s*\{\s*hit/);
    const handlers = [...code.matchAll(/onClick=\{([\s\S]*?)\}(?= id=|>)/g)];
    expect(handlers).toHaveLength(Object.keys(BUTTONS).length);
    for (const match of handlers) {
      const handler = match[1] ?? "";
      expect(() =>
        parseExpression(handler, { plugins: ["typescript"] }),
      ).not.toThrow();
      expect(parseExpression(handler, { plugins: ["typescript"] }).type).toBe(
        "ArrowFunctionExpression",
      );
    }
  });

  it.each([
    ["ifBlock", [1]],
    ["forBlock", [2, 3]],
    ["innerFunction", [4]],
    ["innerArrow", [5]],
    ["semicolons", [6]],
  ])("runs the %s handler on click", (id, hits) => {
    expect(clicks[id]).toEqual(hits);
  });
});
