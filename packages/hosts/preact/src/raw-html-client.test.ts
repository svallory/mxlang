// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A literal `innerHTML=` or `outerHTML=`, and a spread key of either name,
 * must not write markup on a Preact client render or hydration: Preact assigns
 * `innerHTML`/`outerHTML` as DOM properties, and `dangerouslySetInnerHTML` as
 * `innerHTML`. Stock Marko prints them as escaped attributes. The emitter
 * writes them under their lowercase name, which is no DOM property, so Preact
 * calls `setAttribute` and the value stays text. Run in jsdom, in a scratch
 * script (the DOM globals must exist before `preact` loads).
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
import { compilePreactMx } from "./index.ts";

const RAW = "<b>x</b>";
/** JSON data in the shape of a Hono node, a Preact vnode and a React element. */
const OBJECT = {
  tag: "img",
  type: "img",
  props: {
    src: "x",
    onerror: "alert(1)",
    dangerouslySetInnerHTML: { __html: "<i>raw</i>" },
  },
};
let scratch = "";

const CLIENT = `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "Node", "HTMLElement", "Text", "SVGElement"]) {
  globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
}
const { h, render, hydrate } = await import("preact");
const { render: ssr } = await import("preact-render-to-string");
const cases = JSON.parse(process.argv[2]);
const out = [];
for (const { file, input } of cases) {
  const mod = await import(file);
  const client = document.createElement("div");
  document.body.append(client);
  const errors = [];
  const attempt = (fn) => { try { fn(); } catch (error) { errors.push(String(error && error.message)); } };
  attempt(() => render(h(mod.default, input), client));
  let server = "";
  attempt(() => { server = ssr(h(mod.default, input)); });
  const hydrated = document.createElement("div");
  hydrated.innerHTML = server;
  document.body.append(hydrated);
  attempt(() => hydrate(h(mod.default, input), hydrated));
  out.push({
    client: client.innerHTML,
    hydrated: hydrated.innerHTML,
    elements: [...client.querySelectorAll("b"), ...hydrated.querySelectorAll("b")].length,
    injected: [...client.querySelectorAll("img, i, [onerror]"), ...hydrated.querySelectorAll("img, i, [onerror]")].length,
    errors,
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
  objectChild: "<section><div>${input.x}</div></section>",
} as const;

let results: Record<
  keyof typeof SOURCES,
  {
    client: string;
    hydrated: string;
    elements: number;
    injected: number;
    errors: string[];
  }
>;

beforeAll(() => {
  // Under the OS temp dir (a killed run leaves nothing in the worktree); the
  // packages the script imports are linked into its own `node_modules`.
  scratch = mkdtempSync(join(tmpdir(), "mx-preact-raw-html-client-"));
  mkdirSync(join(scratch, "node_modules"));
  for (const name of ["preact", "preact-render-to-string", "jsdom"]) {
    let dir = dirname(require.resolve(name));
    while (basename(dir) !== name) dir = dirname(dir);
    symlinkSync(dir, join(scratch, "node_modules", name), "dir");
  }
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
    }),
  );
  const cases = Object.entries(SOURCES).map(([name, source]) => {
    const file = join(scratch, `${name}.tsx`);
    writeFileSync(file, compilePreactMx(source, file).code);
    return { file, input: { h: RAW, tag: "article", x: OBJECT } };
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

describe("Preact client render and hydration never write markup from innerHTML or outerHTML", () => {
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
    const { client, hydrated, elements } = results[name];
    expect(elements).toBe(0);
    for (const html of [client, hydrated]) {
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

describe("a plain object in a text interpolation is never a node", () => {
  it("renders no element and no markup from JSON-shaped data", () => {
    const { injected, elements } = results.objectChild;
    expect(injected).toBe(0);
    expect(elements).toBe(0);
  });

  it("keeps the surrounding element", () => {
    expect(results.objectChild.client).toMatch(/^<section><div>/);
  });
});
