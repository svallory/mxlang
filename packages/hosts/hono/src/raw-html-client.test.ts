// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A literal `innerHTML=` or `outerHTML=`, and a spread key of either name,
 * must not write markup on a Hono client render or in the server markup: Hono assigns
 * `innerHTML`/`outerHTML` as DOM properties, and `dangerouslySetInnerHTML` as
 * `innerHTML`. Stock Marko prints them as escaped attributes. The emitter
 * writes them under their lowercase name, which is no DOM property, so Hono
 * calls `setAttribute` and the value stays text. Run in jsdom, in a scratch
 * script (the DOM globals must exist before `hono` loads).
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

const RAW = "<b>x</b>";
let scratch = "";

const CLIENT = `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "Node", "HTMLElement", "Text", "SVGElement"]) {
  globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
}
const { render } = await import("hono/jsx/dom");
const { renderToString } = await import("hono/jsx/dom/server");
const { jsx } = await import("hono/jsx");
const cases = JSON.parse(process.argv[2]);
const out = [];
for (const { file, input } of cases) {
  const mod = await import(file);
  const client = document.createElement("div");
  document.body.append(client);
  render(jsx(mod.default, input), client);
  const server = String(renderToString(jsx(mod.default, input)));
  const parsed = document.createElement("div");
  parsed.innerHTML = server;
  out.push({
    client: client.innerHTML,
    parsed: parsed.innerHTML,
    elements: [...client.querySelectorAll("b"), ...parsed.querySelectorAll("b")].length,
  });
}
console.log(JSON.stringify(out));
`;

const SOURCES = {
  literalInner: "<section><div innerHTML=input.h/></section>",
  literalOuter: "<section><div outerHTML=input.h/></section>",
  literalCustomInner: "<section><my-el innerHTML=input.h/></section>",
  literalCustomOuter: "<section><my-el outerHTML=input.h/></section>",
  literalDynamicTag: "<section><${input.tag} innerHTML=input.h/></section>",
  spreadInner: "<section><div ...{ innerHTML: input.h }/></section>",
  spreadOuter: "<section><div ...{ outerHTML: input.h }/></section>",
  spreadDangerous:
    "<section><div ...{ dangerouslySetInnerHTML: input.h }/></section>",
  spreadCustom: "<section><my-el ...{ innerHTML: input.h }/></section>",
  rawChild: "<section><div>$!{input.h}</div></section>",
} as const;

let results: Record<
  keyof typeof SOURCES,
  { client: string; parsed: string; elements: number }
>;

beforeAll(() => {
  // Under the OS temp dir (a killed run leaves nothing in the worktree); the
  // packages the script imports are linked into its own `node_modules`.
  scratch = mkdtempSync(join(tmpdir(), "mx-hono-raw-html-client-"));
  mkdirSync(join(scratch, "node_modules"));
  for (const [name, entry] of [
    ["hono", "hono/jsx"],
    ["jsdom", "jsdom"],
  ] as const) {
    let dir = dirname(require.resolve(entry));
    while (basename(dir) !== name) dir = dirname(dir);
    symlinkSync(dir, join(scratch, "node_modules", name), "dir");
  }
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono" },
    }),
  );
  const cases = Object.entries(SOURCES).map(([name, source]) => {
    const file = join(scratch, `${name}.tsx`);
    writeFileSync(file, compileHonoMx(source, file).code);
    return { file, input: { h: RAW, tag: "article" } };
  });
  const entry = join(scratch, "run.mjs");
  writeFileSync(entry, CLIENT);
  const list = JSON.parse(
    execFileSync("bun", [entry, JSON.stringify(cases)], {
      encoding: "utf8",
      cwd: scratch,
    }),
  ) as (typeof results)[keyof typeof SOURCES][];
  results = Object.fromEntries(
    Object.keys(SOURCES).map((name, index) => [name, list[index]]),
  ) as typeof results;
}, 60_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("Hono client render and server markup never write markup from innerHTML or outerHTML", () => {
  it.each([
    ["literalInner", "innerhtml"],
    ["literalOuter", "outerhtml"],
    ["literalCustomInner", "innerhtml"],
    ["literalCustomOuter", "outerhtml"],
    ["literalDynamicTag", "innerhtml"],
    ["spreadInner", "innerhtml"],
    ["spreadOuter", "outerhtml"],
    ["spreadDangerous", "dangerouslysetinnerhtml"],
    ["spreadCustom", "innerhtml"],
  ] as const)("%s", (name, attribute) => {
    const { client, parsed, elements } = results[name];
    expect(elements).toBe(0);
    for (const html of [client, parsed]) {
      expect(html.startsWith("<section>")).toBe(true);
      expect(html).toContain(`${attribute}="`);
    }
  });

  it("`$!{…}` as the sole child still writes raw markup", () => {
    expect(results.rawChild.client).toBe(
      "<section><div><b>x</b></div></section>",
    );
    expect(results.rawChild.elements).toBeGreaterThan(0);
  });
});
