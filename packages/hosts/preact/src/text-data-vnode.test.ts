// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * Data in a text placeholder, on Preact (server, client and hydration).
 *
 * `<p>${input.x}</p>` hands its value to the renderer as a child. Preact never
 * reads a plain object as markup, but it does read a null-prototype object that
 * has the fields of a vnode as one: `preact-render-to-string` takes any object
 * whose `constructor` is `undefined` for a vnode, and a null-prototype object
 * has no `constructor`. A decoder that builds those (`qs` with `plainObjects`)
 * could therefore put a real `<img onerror=...>` into the server HTML, while
 * the client drops the same value. Stock Marko 6.4.4 prints `[object Object]`
 * for a plain object and throws for a null-prototype one; Preact's own
 * runtime behaviour is to drop a plain object, which MX keeps. The matrix runs
 * every value kind against five placeholder positions.
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
const vnodeFields = () => ({ type: "img", props: PROPS(), key: null, ref: null, __k: null });
const Child = () => h("b", null, "c");
const values = {
  string: () => "s",
  number: () => 7,
  zero: () => 0,
  nullValue: () => null,
  undefinedValue: () => undefined,
  falseValue: () => false,
  trueValue: () => true,
  // Injected on Preact SSR before the fix: no own or inherited constructor.
  nullProto: () => Object.assign(Object.create(null), vnodeFields()),
  nullProtoBare: () => Object.assign(Object.create(null), { type: "img", props: PROPS() }),
  protoWithoutConstructor: () => Object.assign(Object.create(Object.create(null)), vnodeFields()),
  nullProtoCtorNull: () => Object.assign(Object.create(null), JSON.parse('{"type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null,"__k":null,"constructor":null}')),
  // Dropped by Preact itself, kept dropped.
  plain: () => vnodeFields(),
  plainTag: () => ({ tag: "img", props: PROPS() }),
  json: () => JSON.parse('{"type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null,"__k":null,"constructor":null}'),
  protoGadget: () => Object.assign({}, JSON.parse('{"__proto__":{"z":1},"type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}')),
  // An array as the copy's prototype: its constructor is Array, not a data object.
  arrayProtoGadget: () => Object.assign({}, JSON.parse('{"__proto__":[],"type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}')),
  arrayProtoGadgetDeep: () => Object.assign({}, JSON.parse('{"__proto__":{"__proto__":[]},"type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}')),
  arrayHoldingArrayProtoGadget: () => [Object.assign({}, JSON.parse('{"__proto__":[],"type":"img","props":{"src":"x"},"key":null,"ref":null}'))],
  forgedReact: () => ({ $$typeof: "react.element", type: "img", props: PROPS(), key: null, ref: null }),
  arrayNullProto: () => [Object.assign(Object.create(null), vnodeFields())],
  arrayMixed: () => ["a", Object.assign(Object.create(null), vnodeFields()), "b", vnodeFields(), h("i", null, "n")],
  arrayPlain: () => [vnodeFields(), "t"],
  // What Preact builds itself.
  node: () => h("i", null, "n"),
  jsxRuntime: () => jsx("i", { children: "j" }),
  jsxsRuntime: () => jsxs("i", { children: ["j", "k"] }),
  fragment: () => h(Fragment, null, h("i", null, "f"), "g"),
  cloned: () => cloneElement(h("i", { class: "a" }, "n"), { class: "c" }),
  componentReturn: () => Child(),
  componentElement: () => h(Child, null),
  nodes: () => [h("i", null, "a"), "-", h("b", null, h("u", null, "c"))],
  nodesAndText: () => ["x", h("i", null, "n"), 1, null, "y"],
  // Only a decoder that keeps undefined (devalue, superjson, structuredClone) builds this.
  forgedCtor: () => ({ ...vnodeFields(), constructor: undefined }),
};
`;

const RUNNER = `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "Node", "HTMLElement", "Text", "SVGElement"]) {
  globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
}
const { h, render, hydrate, Fragment, cloneElement } = await import("preact");
const { jsx, jsxs } = await import("preact/jsx-runtime");
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
  attempt(() => render(h(mod.default, { x: values[value](), y: h("i", null, "y") }), client));
  result.client = client.innerHTML;
  result.server = attempt(() => String(ssr(h(mod.default, { x: values[value](), y: h("i", null, "y") })))) ?? "";
  const hydrated = document.createElement("div");
  hydrated.innerHTML = result.server;
  document.body.append(hydrated);
  attempt(() => hydrate(h(mod.default, { x: values[value](), y: h("i", null, "y") }), hydrated));
  result.hydrated = hydrated.innerHTML;
  result.injected = client.querySelectorAll("img, [onerror]").length + hydrated.querySelectorAll("img, [onerror]").length;
  out[name] = result;
}
console.log(JSON.stringify(out));
`;

const SOURCES = {
  wrapped: "<p>${input.x}</p>",
  mixed: "<p>a${input.x}b</p>",
  pair: "<p>${input.x}${input.y}</p>",
  inIf: "<if=true>${input.x}</if>",
  inFor: "<for|v| of=[input.x]>${v}</for>",
} as const;
type Shape = keyof typeof SOURCES;
const SHAPES = Object.keys(SOURCES) as Shape[];

/** Every value kind the runner can build. */
const VALUE_NAMES = [
  "string",
  "number",
  "zero",
  "nullValue",
  "undefinedValue",
  "falseValue",
  "trueValue",
  "nullProto",
  "nullProtoBare",
  "protoWithoutConstructor",
  "nullProtoCtorNull",
  "plain",
  "plainTag",
  "json",
  "protoGadget",
  "arrayProtoGadget",
  "arrayProtoGadgetDeep",
  "arrayHoldingArrayProtoGadget",
  "forgedReact",
  "arrayNullProto",
  "arrayMixed",
  "arrayPlain",
  "node",
  "jsxRuntime",
  "jsxsRuntime",
  "fragment",
  "cloned",
  "componentReturn",
  "componentElement",
  "nodes",
  "nodesAndText",
  "forgedCtor",
] as const;
type ValueName = (typeof VALUE_NAMES)[number];

interface Result {
  client: string;
  server: string;
  hydrated: string;
  injected: number;
  errors: string[];
}
let results: Record<string, Result>;
const key = (shape: Shape, value: ValueName): string => `${shape}:${value}`;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "mx-preact-text-data-"));
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
  const cases = SHAPES.flatMap((shape) =>
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
  if (process.env.MX_PROBE_TABLE) {
    for (const [name, r] of Object.entries(results)) {
      console.log(
        `${name}\tserver=${JSON.stringify(r.server)}\tclient=${JSON.stringify(r.client)}\thydrated=${JSON.stringify(r.hydrated)}\terrors=${JSON.stringify(r.errors)}`,
      );
    }
  }
}, 180_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const at = (shape: Shape, value: ValueName): Result =>
  results[key(shape, value)] as Result;

/** The page a shape makes of `inner`. */
const page = (shape: Shape, inner: string): string =>
  shape === "wrapped"
    ? `<p>${inner}</p>`
    : shape === "mixed"
      ? `<p>a${inner}b</p>`
      : shape === "pair"
        ? `<p>${inner}<i>y</i></p>`
        : inner;

/** Values that are data: Preact's client renders nothing for them, and so must the server. */
const DATA: ValueName[] = [
  "nullProto",
  "nullProtoBare",
  "protoWithoutConstructor",
  "nullProtoCtorNull",
  "plain",
  "plainTag",
  "json",
  "protoGadget",
  "arrayProtoGadget",
  "arrayProtoGadgetDeep",
  "arrayHoldingArrayProtoGadget",
  "forgedReact",
  "arrayNullProto",
  "arrayPlain",
];

describe("data in a text placeholder renders nothing, never markup (Preact server, client, hydration)", () => {
  for (const shape of SHAPES) {
    for (const value of DATA) {
      it(`${shape}: ${value}`, () => {
        const r = at(shape, value);
        const expected = page(shape, value === "arrayPlain" ? "t" : "");
        expect(r.errors).toEqual([]);
        expect(r.injected).toBe(0);
        expect(r.server).toBe(expected);
        expect(r.client).toBe(expected);
        expect(r.hydrated).toBe(expected);
      });
    }
    it(`${shape}: an array keeps its text and vnodes and drops the data`, () => {
      const r = at(shape, "arrayMixed");
      expect(r.errors).toEqual([]);
      expect(r.injected).toBe(0);
      // "a", data, "b", data, vnode: text and the vnode stay, in order.
      const inner = "ab<i>n</i>";
      expect(r.server).toBe(page(shape, inner));
      expect(r.client).toBe(page(shape, inner));
      expect(r.hydrated).toBe(page(shape, inner));
    });
  }
});

describe("what a text placeholder renders as before (Preact server, client, hydration)", () => {
  const SAME: [ValueName, string][] = [
    ["string", "s"],
    ["number", "7"],
    ["zero", "0"],
    ["nullValue", ""],
    ["undefinedValue", ""],
    ["falseValue", ""],
    ["trueValue", ""],
    ["node", "<i>n</i>"],
    ["jsxRuntime", "<i>j</i>"],
    ["jsxsRuntime", "<i>jk</i>"],
    ["fragment", "<i>f</i>g"],
    ["cloned", '<i class="c">n</i>'],
    ["componentReturn", "<b>c</b>"],
    ["componentElement", "<b>c</b>"],
    ["nodes", "<i>a</i>-<b><u>c</u></b>"],
    ["nodesAndText", "x<i>n</i>1y"],
  ];
  for (const shape of SHAPES) {
    for (const [value, inner] of SAME) {
      it(`${shape}: ${value}`, () => {
        const r = at(shape, value);
        const expected = page(shape, inner);
        expect(r.errors).toEqual([]);
        expect(r.server).toBe(expected);
        expect(r.client).toBe(expected);
        expect(r.hydrated).toBe(expected);
      });
    }
  }
});

describe("the one shape a decoder can forge (Preact)", () => {
  // A vnode is told from data by an own `constructor` set to `undefined`.
  // JSON cannot carry that, but a decoder that keeps `undefined` (devalue,
  // superjson, structuredClone) can, and the result is indistinguishable from
  // a vnode: such data must never reach a text placeholder.
  it("is read as a vnode, like Preact's own check", () => {
    expect(at("wrapped", "forgedCtor").server).toContain("onerror");
  });
});
