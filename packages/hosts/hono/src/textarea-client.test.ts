/**
 * `<textarea value=x/>` renders as content and a leading newline is doubled
 * for the server only (the HTML parser drops a textarea's first newline, so
 * Marko writes two). `hono/jsx/dom`'s `render` accepts the emitted module's
 * nodes and sets the text through the DOM, where a doubled newline would show
 * as a second one: this test pins that the client render keeps `value === x`
 * while the string renderer's markup carries the extra newline.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
let scratch = "";
let componentFile = "";

const SERVER = (file: string) => `
import { jsx } from "hono/jsx";
const mod = await import(${JSON.stringify(file)});
console.log(JSON.stringify(String(await jsx(mod.default, { v: JSON.parse(process.argv[2]) }).toString())));
`;

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
const root = document.getElementById("r");
render(jsx(mod.default, { v: JSON.parse(process.argv[2]) }), root);
const parsed = document.createElement("div");
parsed.innerHTML = JSON.parse(process.argv[3]);
console.log(JSON.stringify({
  client: root.querySelector("textarea").value,
  parsed: parsed.querySelector("textarea").value,
}));
`;

function run(script: string, ...args: string[]): unknown {
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
    compileHonoMx("<textarea value=input.v/>", componentFile).code,
  );
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("<textarea value> leading newline: server vs client (Hono)", () => {
  it.each(["x", "\nx", "\n\nx"])(
    "%j",
    (value) => {
      const serverHtml = run(
        SERVER(componentFile),
        JSON.stringify(value),
      ) as string;
      // SSR markup carries one extra newline for the parser to drop.
      expect(serverHtml).toBe(
        `<textarea>${value.startsWith("\n") ? "\n" : ""}${value}</textarea>`,
      );
      const result = run(
        CLIENT(componentFile),
        JSON.stringify(value),
        JSON.stringify(serverHtml),
      ) as { client: string; parsed: string };
      expect(result.client).toBe(value);
      expect(result.parsed).toBe(value);
    },
    30_000,
  );
});
