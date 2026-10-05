/**
 * `<textarea value=x/>` renders as content and a leading newline is doubled
 * for the server only (the HTML parser drops a textarea's first newline, so
 * Marko writes two). A Preact client render sets the text through the DOM,
 * where a doubled newline would show as a second one: this test pins that the
 * client render and a hydration of the server HTML both keep `value === x`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
let scratch = "";
let componentFile = "";

const SERVER = (file: string) => `
import { h } from "preact";
import { render } from "preact-render-to-string";
const mod = await import(${JSON.stringify(file)});
console.log(JSON.stringify(render(h(mod.default, { v: JSON.parse(process.argv[2]) }))));
`;

const CLIENT = (file: string) => `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
const warnings = [];
console.warn = console.error = (...args) => warnings.push(args.join(" "));
const { h, render, hydrate } = await import("preact");
const mod = await import(${JSON.stringify(file)});
const value = JSON.parse(process.argv[2]);
const serverHtml = JSON.parse(process.argv[3]);
const client = document.createElement("div");
render(h(mod.default, { v: value }), client);
const hydrated = document.createElement("div");
hydrated.innerHTML = serverHtml;
const parsed = hydrated.querySelector("textarea").value;
hydrate(h(mod.default, { v: value }), hydrated);
console.log(JSON.stringify({
  client: client.querySelector("textarea").value,
  parsed,
  hydrated: hydrated.querySelector("textarea").value,
  warnings,
}));
`;

function run(script: string, file: string, ...args: string[]): unknown {
  const entry = join(scratch, `run${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(entry, script);
  return JSON.parse(
    execFileSync("bun", [entry, ...args], { encoding: "utf8", cwd: scratch }),
  );
}

beforeAll(() => {
  scratch = mkdtempSync(join(packageDir, ".textarea-client-"));
  componentFile = join(scratch, "case.tsx");
  writeFileSync(
    componentFile,
    compilePreactMx("<textarea value=input.v/>", componentFile).code,
  );
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("<textarea value> leading newline: server vs client (Preact)", () => {
  it.each(["x", "\nx", "\n\nx"])(
    "%j",
    (value) => {
      const serverHtml = run(
        SERVER(componentFile),
        componentFile,
        JSON.stringify(value),
      ) as string;
      // SSR markup carries one extra newline for the parser to drop.
      expect(serverHtml).toBe(
        `<textarea>${value.startsWith("\n") ? "\n" : ""}${value}</textarea>`,
      );
      const result = run(
        CLIENT(componentFile),
        componentFile,
        JSON.stringify(value),
        JSON.stringify(serverHtml),
      ) as {
        client: string;
        parsed: string;
        hydrated: string;
        warnings: string[];
      };
      expect(result.client).toBe(value);
      expect(result.parsed).toBe(value);
      expect(result.hydrated).toBe(value);
      expect(result.warnings).toEqual([]);
    },
    30_000,
  );
});
