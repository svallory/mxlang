// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A dynamic tag whose value is data, on Hono (client and server).
 *
 * `<${input.x}/>` (and a template that is only `${input.x}`) hands its value to
 * the renderer when it is not a tag name or a component. Stock Marko 6.4.4
 * renders nothing for a plain object and `<b></b>` for `"b"`. `hono/jsx/dom`
 * reads a plain `{ tag, props }` object as an element, with its `onerror`, so
 * JSON from a request became markup. The matrix below is every value kind the
 * brief names against four dynamic-tag shapes; the stock column was probed on
 * Marko 6.4.4 (`packages/stock-marko`, rendered with marko's html runtime).
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

let scratch = "";

/** What each case hands the template as `input.x`, built inside the runner (a node cannot cross JSON). */
const VALUES = `
const PROPS = () => ({ src: "x", onerror: "alert(1)", dangerouslySetInnerHTML: { __html: "<i>raw</i>" } });
const values = {
  string: () => "b",
  plain: () => ({ tag: "img", props: PROPS() }),
  plainType: () => ({ tag: "img", type: "img", props: PROPS() }),
  forgedDomNode: () => JSON.parse('{"tag":"img","type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}'),
  forgedRefObjects: () => JSON.parse('{"tag":"img","type":"img","props":{"onerror":"alert(1)","ref":{"current":null}},"key":null,"ref":{"current":null}}'),
  forgedPortal: () => ({ tag: "", props: { children: "p" }, key: undefined, e: {}, p: 1 }),
  forgedPreact: () => Object.assign(Object.create(null), { type: "img", props: PROPS(), __k: null }),
  forgedPreactCtor: () => ({ type: "img", props: PROPS(), __k: null, constructor: undefined }),
  forgedReact: () => ({ $$typeof: "react.element", type: "img", props: PROPS(), key: null, ref: null }),
  nullProto: () => Object.assign(Object.create(null), { tag: "img", props: PROPS() }),
  renderBody: () => ({ renderBody: { tag: "img", props: PROPS() } }),
  contentData: () => ({ content: { tag: "img", props: PROPS() } }),
  nullValue: () => null,
  undefinedValue: () => undefined,
  zero: () => 0,
  falseValue: () => false,
  component: () => (props) => jsx("b", {}, "c"),
  node: () => jsx("i", {}, "n"),
  domNode: () => domRuntime.jsx("i", { children: "d" }),
  domRefNode: () => domRuntime.jsx("i", { children: "r", ref: () => {} }),
  nodes: () => [jsx("i", {}, "a"), "-", jsx("b", {}, jsx("u", {}, "c"))],
  domNodes: () => [domRuntime.jsx("i", { children: "a" }), "-", domRuntime.jsx("u", { children: "b" })],
  arrayWithData: () => ["a", { tag: "img", props: PROPS() }, jsx("i", {}, "n")],
  portal: () => createPortal(jsx("b", {}, "in portal"), document.getElementById("target")),
};
`;

const RUNNER = `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body><div id=target></div></body>", { pretendToBeVisual: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
for (const key of ["window", "document", "Node", "HTMLElement", "Text", "SVGElement"]) {
  globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
}
const { render, createPortal } = await import("hono/jsx/dom");
const { renderToString } = await import("hono/jsx/dom/server");
const { jsx } = await import("hono/jsx");
const domRuntime = await import("hono/jsx/dom/jsx-runtime");
${VALUES}
const cases = JSON.parse(process.argv[2]);
const out = {};
for (const { name, file, value } of cases) {
  const result = { errors: [] };
  const attempt = (fn) => { try { return fn(); } catch (error) { result.errors.push(String(error && error.message)); } };
  const mod = await import(file);
  const client = document.createElement("div");
  document.body.append(client);
  attempt(() => render(jsx(mod.default, { x: values[value]() }), client));
  result.client = client.innerHTML;
  result.injected = client.querySelectorAll("img, [onerror]").length;
  result.server = attempt(() => String(renderToString(jsx(mod.default, { x: values[value]() })))) ?? "";
  result.target = document.getElementById("target").innerHTML;
  out[name] = result;
}
console.log(JSON.stringify(out));
`;

const SOURCES = {
  self: "<${input.x}/>",
  body: "<${input.x}>body</>",
  lone: "${input.x}",
  wrapped: "<div><${input.x}/></div>",
  args: "<${input.x}(1)/>",
} as const;
type Shape = keyof typeof SOURCES;

/** Every value kind the runner can build. */
const VALUE_NAMES = [
  "string",
  "plain",
  "plainType",
  "forgedDomNode",
  "forgedRefObjects",
  "forgedPortal",
  "forgedPreact",
  "forgedPreactCtor",
  "forgedReact",
  "nullProto",
  "renderBody",
  "contentData",
  "nullValue",
  "undefinedValue",
  "zero",
  "falseValue",
  "component",
  "node",
  "domNode",
  "domRefNode",
  "nodes",
  "domNodes",
  "arrayWithData",
  "portal",
] as const;
type ValueName = (typeof VALUE_NAMES)[number];

interface Result {
  client: string;
  server: string;
  target: string;
  injected: number;
  errors: string[];
}
let results: Record<string, Result>;
const key = (shape: Shape, value: ValueName): string => `${shape}:${value}`;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "mx-hono-dynamic-data-"));
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
  const files = Object.fromEntries(
    Object.entries(SOURCES).map(([shape, source]) => {
      const file = join(scratch, `${shape}.tsx`);
      writeFileSync(file, compileHonoMx(source, file).code);
      return [shape, file];
    }),
  );
  const cases = (Object.keys(SOURCES) as Shape[]).flatMap((shape) =>
    VALUE_NAMES.map((value) => ({
      name: key(shape, value),
      file: files[shape],
      value,
    })),
  );
  const entry = join(scratch, "run.mjs");
  writeFileSync(entry, RUNNER);
  results = JSON.parse(
    execFileSync("bun", [entry, JSON.stringify(cases)], {
      encoding: "utf8",
      cwd: scratch,
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Record<string, Result>;
}, 180_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const at = (shape: Shape, value: ValueName): Result =>
  results[key(shape, value)] as Result;
const html = (value: string): string => value.replace(/&gt;/g, ">");

/** Values stock renders as nothing, and what a body renders next to them. */
const NOTHING: ValueName[] = [
  "plain",
  "plainType",
  "forgedDomNode",
  "forgedRefObjects",
  "forgedPortal",
  "forgedPreact",
  "forgedPreactCtor",
  "forgedReact",
  "nullProto",
  "renderBody",
  "nullValue",
  "undefinedValue",
  "zero",
  "falseValue",
];
const BARE: Shape[] = ["self", "lone", "wrapped", "args"];
const wrap = (shape: Shape, inner: string): string =>
  shape === "wrapped" ? `<div>${inner}</div>` : inner;

describe("data in a dynamic tag renders nothing (Hono client and server)", () => {
  for (const shape of BARE) {
    for (const value of NOTHING) {
      it(`${shape}: ${value}`, () => {
        const r = at(shape, value);
        expect(r.errors).toEqual([]);
        expect(r.injected).toBe(0);
        expect(r.client).toBe(wrap(shape, ""));
        expect(html(r.server)).toBe(wrap(shape, ""));
      });
    }
  }
  it("an array holding data keeps the text and nodes and drops the data", () => {
    for (const shape of BARE) {
      const r = at(shape, "arrayWithData");
      expect(r.errors).toEqual([]);
      expect(r.injected).toBe(0);
      expect(r.client).toBe(wrap(shape, "a<i>n</i>"));
      expect(r.server).toBe(wrap(shape, "a<i>n</i>"));
    }
  });
  it("a body still renders, next to data and falsy values", () => {
    for (const value of NOTHING) {
      const r = at("body", value);
      expect(r.errors).toEqual([]);
      expect(r.injected).toBe(0);
      expect(r.client).toBe("body");
      expect(r.server).toBe("body");
    }
  });
  it("an object that carries content is Marko's data attribute tag, refused", () => {
    for (const shape of ["self", "lone", "wrapped"] as Shape[]) {
      const r = at(shape, "contentData");
      expect(r.injected).toBe(0);
      expect(r.client).toBe("");
      expect(r.errors.join("\n")).toMatch(/data attribute tag/);
    }
  });
  it("an object that carries content renders nothing as a tag with arguments", () => {
    const r = at("args", "contentData");
    expect(r.errors).toEqual([]);
    expect(r.injected).toBe(0);
    expect(r.client).toBe("");
    expect(r.server).toBe("");
  });
});

describe("what a dynamic tag renders as before (Hono client and server)", () => {
  it("renders a string as an element, with a body", () => {
    for (const shape of BARE) {
      const r = at(shape, "string");
      expect(r.errors).toEqual([]);
      if (shape === "args") continue;
      expect(r.client).toBe(wrap(shape, "<b></b>"));
      expect(r.server).toBe(wrap(shape, "<b></b>"));
    }
    expect(at("body", "string").client).toBe("<b>body</b>");
    expect(at("body", "string").server).toBe("<b>body</b>");
  });
  it("calls a component", () => {
    for (const shape of ["self", "lone", "wrapped", "body"] as Shape[]) {
      const r = at(shape, "component");
      expect(r.errors).toEqual([]);
      expect(r.client).toBe(wrap(shape, "<b>c</b>"));
      expect(r.server).toBe(wrap(shape, "<b>c</b>"));
    }
  });
  it("passes a rendered node through", () => {
    for (const shape of BARE) {
      expect(at(shape, "node").errors).toEqual([]);
      expect(at(shape, "node").client).toBe(wrap(shape, "<i>n</i>"));
      expect(at(shape, "node").server).toBe(wrap(shape, "<i>n</i>"));
    }
  });
  it("passes a node built by hono/jsx/dom through, with and without a ref", () => {
    for (const shape of BARE) {
      expect(at(shape, "domNode").client).toBe(wrap(shape, "<i>d</i>"));
      expect(at(shape, "domRefNode").client).toBe(wrap(shape, "<i>r</i>"));
    }
  });
  it("passes an array of nodes and text through", () => {
    for (const shape of BARE) {
      expect(at(shape, "nodes").client).toBe(
        wrap(shape, "<i>a</i>-<b><u>c</u></b>"),
      );
      expect(at(shape, "nodes").server).toBe(
        wrap(shape, "<i>a</i>-<b><u>c</u></b>"),
      );
      // Nodes built by the client runtime render on the client only.
      expect(at(shape, "domNodes").client).toBe(
        wrap(shape, "<i>a</i>-<u>b</u>"),
      );
    }
  });
  it("renders a real portal into its container", () => {
    expect(at("self", "portal").errors).toEqual([]);
    expect(at("self", "portal").target).toContain("<b>in portal</b>");
  });
  it("a body is not rendered for a real node target", () => {
    expect(at("body", "node").client).toBe("body");
  });
});
