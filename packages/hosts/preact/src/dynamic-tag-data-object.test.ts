// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A dynamic tag whose value is data, on Preact (client and server).
 *
 * `<${input.x}/>` (and a template that is only `${input.x}`) hands its value to
 * the renderer when it is not a tag name or a component. Stock Marko 6.4.4
 * renders nothing for a plain object and `<b></b>` for `"b"`. Preact
 * drops a plain object it does not recognise as a vnode; a null-prototype
 * object has no `constructor` and is read as a vnode by Preact's own check, so
 * a decoder that builds those (`qs` with `plainObjects`) could reach `type`,
 * `props` and its handlers. The matrix below is every value kind the
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
import { compilePreactMx } from "./index.ts";

let scratch = "";

/** What each case hands the template as `input.x`, built inside the runner (a vnode cannot cross JSON). */
const VALUES = `
const PROPS = () => ({ src: "x", onerror: "alert(1)", dangerouslySetInnerHTML: { __html: "<i>raw</i>" } });
const values = {
  string: () => "b",
  plain: () => ({ tag: "img", props: PROPS() }),
  plainType: () => ({ tag: "img", type: "img", props: PROPS() }),
  forgedDomNode: () => JSON.parse('{"tag":"img","type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}'),
  forgedRefObjects: () => JSON.parse('{"tag":"img","type":"img","props":{"onerror":"alert(1)","ref":{"current":null}},"key":null,"ref":{"current":null}}'),
  forgedPortal: () => ({ tag: "", props: { children: "p" }, key: undefined, e: {}, p: 1 }),
  forgedPreactJson: () => JSON.parse('{"type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null,"__k":null,"constructor":null}'),
  forgedPreact: () => Object.assign(Object.create(null), { type: "img", props: PROPS(), key: null, ref: null, __k: null }),
  forgedReact: () => ({ $$typeof: "react.element", type: "img", props: PROPS(), key: null, ref: null }),
  nullProto: () => Object.assign(Object.create(null), { tag: "img", props: PROPS() }),
  protoGadget: () => Object.assign({}, JSON.parse('{"__proto__":{"z":1},"tag":"img","type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}')),
  protoGadgetCtor: () => Object.assign({}, JSON.parse('{"__proto__":{"constructor":null},"tag":"img","type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}')),
  // An array as the copy's prototype: its constructor is Array, not a data object.
  arrayProtoGadget: () => Object.assign({}, JSON.parse('{"__proto__":[],"tag":"img","type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}')),
  arrayProtoGadgetDeep: () => Object.assign({}, JSON.parse('{"__proto__":{"__proto__":[]},"tag":"img","type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}')),
  arrayHoldingArrayProtoGadget: () => [Object.assign({}, JSON.parse('{"__proto__":[],"tag":"img","type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}'))],
  renderBody: () => ({ renderBody: { type: "img", props: PROPS() } }),
  contentData: () => ({ content: { type: "img", props: PROPS() } }),
  nullValue: () => null,
  undefinedValue: () => undefined,
  zero: () => 0,
  falseValue: () => false,
  component: () => (props) => h("b", null, "c"),
  node: () => h("i", null, "n"),
  fragment: () => h(Fragment, null, h("i", null, "f"), "g"),
  nodes: () => [h("i", null, "a"), "-", h("b", null, h("u", null, "c"))],
  arrayWithData: () => ["a", { type: "img", props: PROPS() }, Object.assign(Object.create(null), { type: "img", props: PROPS() }), h("i", null, "n")],
  // Only a decoder that keeps undefined (devalue, superjson, structuredClone) builds this.
  forgedPreactCtor: () => ({ type: "img", props: PROPS(), key: null, ref: null, __k: null, constructor: undefined }),
};
`;

const RUNNER = `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "Node", "HTMLElement", "Text", "SVGElement"]) {
  globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
}
const { h, render, Fragment } = await import("preact");
const { render: ssr } = await import("preact-render-to-string");
${VALUES}
const cases = JSON.parse(process.argv[2]);
const out = {};
for (const { name, file, value } of cases) {
  const result = { errors: [] };
  const attempt = (fn) => { try { return fn(); } catch (error) { result.errors.push(String(error && error.message)); } };
  const mod = await import(file);
  const client = document.createElement("div");
  document.body.append(client);
  attempt(() => render(h(mod.default, { x: values[value]() }), client));
  result.client = client.innerHTML;
  result.injected = client.querySelectorAll("img, [onerror]").length;
  result.server = attempt(() => String(ssr(h(mod.default, { x: values[value]() })))) ?? "";
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
  "forgedPreactJson",
  "forgedPreact",
  "forgedReact",
  "nullProto",
  "protoGadget",
  "protoGadgetCtor",
  "arrayProtoGadget",
  "arrayProtoGadgetDeep",
  "arrayHoldingArrayProtoGadget",
  "renderBody",
  "contentData",
  "nullValue",
  "undefinedValue",
  "zero",
  "falseValue",
  "component",
  "node",
  "fragment",
  "nodes",
  "arrayWithData",
  "forgedPreactCtor",
] as const;
type ValueName = (typeof VALUE_NAMES)[number];

interface Result {
  client: string;
  server: string;
  injected: number;
  errors: string[];
}
let results: Record<string, Result>;
const key = (shape: Shape, value: ValueName): string => `${shape}:${value}`;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "mx-preact-dynamic-data-"));
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
  const files = Object.fromEntries(
    Object.entries(SOURCES).map(([shape, source]) => {
      const file = join(scratch, `${shape}.tsx`);
      writeFileSync(file, compilePreactMx(source, file).code);
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

/** Values stock renders as nothing, and what a body renders next to them. */
const NOTHING: ValueName[] = [
  "plain",
  "plainType",
  "forgedDomNode",
  "forgedRefObjects",
  "forgedPortal",
  "forgedPreactJson",
  "forgedPreact",
  "forgedReact",
  "nullProto",
  "protoGadget",
  "protoGadgetCtor",
  "arrayProtoGadget",
  "arrayProtoGadgetDeep",
  "arrayHoldingArrayProtoGadget",
  "renderBody",
  "nullValue",
  "undefinedValue",
  "zero",
  "falseValue",
];
const BARE: Shape[] = ["self", "lone", "wrapped", "args"];
const wrap = (shape: Shape, inner: string): string =>
  shape === "wrapped" ? `<div>${inner}</div>` : inner;

describe("data in a dynamic tag renders nothing (Preact client and server)", () => {
  for (const shape of BARE) {
    for (const value of NOTHING) {
      it(`${shape}: ${value}`, () => {
        const r = at(shape, value);
        expect(r.errors).toEqual([]);
        expect(r.injected).toBe(0);
        expect(r.client).toBe(wrap(shape, ""));
        expect(r.server).toBe(wrap(shape, ""));
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

describe("what a dynamic tag renders as before (Preact client and server)", () => {
  it("renders a string as an element, with a body", () => {
    for (const shape of ["self", "lone", "wrapped"] as Shape[]) {
      const r = at(shape, "string");
      expect(r.errors).toEqual([]);
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
  it("passes a vnode, a fragment and an array of nodes through", () => {
    for (const shape of BARE) {
      expect(at(shape, "node").errors).toEqual([]);
      expect(at(shape, "node").client).toBe(wrap(shape, "<i>n</i>"));
      expect(at(shape, "node").server).toBe(wrap(shape, "<i>n</i>"));
      expect(at(shape, "fragment").client).toBe(wrap(shape, "<i>f</i>g"));
      expect(at(shape, "fragment").server).toBe(wrap(shape, "<i>f</i>g"));
      expect(at(shape, "nodes").client).toBe(
        wrap(shape, "<i>a</i>-<b><u>c</u></b>"),
      );
      expect(at(shape, "nodes").server).toBe(
        wrap(shape, "<i>a</i>-<b><u>c</u></b>"),
      );
    }
  });
  it("renders the body, not a node target, when there is a body", () => {
    expect(at("body", "node").client).toBe("body");
  });
});

describe("the one shape a decoder can forge (Preact)", () => {
  // A vnode is told from data by an own `constructor` set to `undefined`.
  // JSON cannot carry that, but a decoder that keeps `undefined` (devalue,
  // superjson, structuredClone) can, and the result is indistinguishable from
  // a vnode: such data must never reach a dynamic tag.
  it("is read as a vnode by the server renderer, like Preact's own check", () => {
    expect(at("self", "forgedPreactCtor").server).toContain("onerror");
  });
});
