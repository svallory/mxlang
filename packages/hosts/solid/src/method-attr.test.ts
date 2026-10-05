import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import { parseExpression } from "@babel/parser";
import typescriptPreset from "@babel/preset-typescript";
import { sourceBindings, unknownSourceBindings } from "@mxlang/tsx-bridge";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { beforeAll, describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

/**
 * Every function value is emitted as written: a method shorthand
 * (`onClick() { … }`) as the `function` expression the compiler printed for
 * it, an authored `function` expression or arrow unchanged. A regex over the
 * printed function once turned methods into arrows and split them at the last
 * `) {`, emitting `() { if (c) => { … } }` (not JavaScript); converting a
 * named function or a generic method to an arrow also loses its name binding
 * or is invalid TSX (`<T>` reads as a tag), and an arrow cannot take `this`.
 */
const BUTTONS: Record<string, string> = {
  ifBlock: "onClick() { if (input.on) { hit(1) } }",
  forBlock: "onClick() { for (const n of [2, 3]) { hit(n) } }",
  innerFunction:
    "onClick() { const add = function (n: number) { hit(n) }; add(4) }",
  innerArrow: "onClick(e: Event) { [5].forEach((n) => { if (e) { hit(n) } }) }",
  semicolons: "onClick() { if (input.on) { hit(6); } }",
  asyncAwait:
    "async onClick() { await Promise.resolve(); if (input.on) { hit(7) } }",
  generic: "onClick<T>(e: T) { if (e) { hit(8) } }",
  named:
    "onClick=function tick(e: Event, n = 0) { if (n < 2) { tick(e, n + 1) } else { hit(9) } }",
  thisParam:
    'onClick(this: HTMLElement) { hit(this.id === "thisParam" ? 10 : 0) }',
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
        "  await new Promise((r) => setTimeout(r, 0));",
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

/** Each `onClick` attribute of the emitted JSX: its value's node type and text. */
function handlers(code: string): { type: string; text: string }[] {
  const out: { type: string; text: string }[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const value = node as Record<string, unknown> & {
      type?: string;
      name?: { name?: string };
      value?: { expression?: { type: string; start: number; end: number } };
    };
    if (value.type === "JSXAttribute" && value.name?.name === "onClick") {
      const expression = value.value?.expression;
      if (expression) {
        out.push({
          type: expression.type,
          text: code.slice(expression.start, expression.end),
        });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "loc") visit(child);
    }
  };
  visit(parseExpression(code, { plugins: ["typescript", "jsx"] }));
  return out;
}

describe("method attribute values", () => {
  it("emits every handler as a function expression that parses as TSX", () => {
    const found = handlers(compile());
    expect(found).toHaveLength(Object.keys(BUTTONS).length);
    for (const handler of found) {
      expect(handler.type).toBe("FunctionExpression");
    }
  });

  it("keeps async, type parameters, a name and a this parameter", () => {
    const texts = handlers(compile()).map((handler) => handler.text);
    expect(texts).toContainEqual(expect.stringMatching(/^async function \(\)/));
    expect(texts).toContainEqual(
      expect.stringMatching(/^function <T>\(e: T\)/),
    );
    expect(texts).toContainEqual(
      "function tick(e: Event, n = 0) { if (n < 2) { tick(e, n + 1) } else { hit(9) } }",
    );
    expect(texts).toContainEqual(
      expect.stringMatching(/^function \(this: HTMLElement\)/),
    );
  });

  it.each([
    ["ifBlock", [1]],
    ["forBlock", [2, 3]],
    ["innerFunction", [4]],
    ["innerArrow", [5]],
    ["semicolons", [6]],
    ["asyncAwait", [7]],
    ["generic", [8]],
    ["named", [9]],
    ["thisParam", [10]],
  ])("runs the %s handler on click", (id, hits) => {
    expect(clicks[id]).toEqual(hits);
  });
});
