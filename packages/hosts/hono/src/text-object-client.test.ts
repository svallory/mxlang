// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A `${expr}` placeholder holding JSON-shaped data on the Hono client.
 *
 * Stock Marko 6.4.4 prints a plain object in text as `[object Object]`.
 * `hono/jsx/dom` instead reads a plain `{ tag, props }` object as an element,
 * with its `onerror` and `dangerouslySetInnerHTML`. The emitter wraps a
 * placeholder in `__mxTextValue`, which stringifies a plain object and leaves
 * everything the renderer made itself alone. These tests render for real in
 * jsdom (the DOM globals must exist before `hono` loads) and compare with the
 * server string renderer.
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

/** What each case hands the template as `input`, built inside the runner (a node cannot cross JSON). */
const INPUTS = `
const DATA = { tag: "img", type: "img", props: { src: "x", onerror: "alert(1)", dangerouslySetInnerHTML: { __html: "<i>raw</i>" } } };
const inputs = {
  data: () => ({ x: DATA }),
  dataArray: () => ({ x: ["a", DATA, { tag: "b", props: { children: "n" } }] }),
  forgedPortal: () => ({ x: { tag: "", props: { children: "p" }, key: undefined, e: {}, p: 1 } }),
  toString: () => ({ x: { toString: () => "<b>own</b>" } }),
  valueOf: () => ({ x: { valueOf: () => "<u>v</u>" } }),
  nullProto: () => ({ x: Object.assign(Object.create(null), { a: 1 }) }),
  primitives: () => ({ a: "s<", b: 0, c: null, d: undefined, e: false, f: [1, "x"] }),
  node: () => ({ x: jsx("i", {}, "node") }),
  nodes: () => ({ x: [jsx("i", {}, "a"), "-", jsx("b", {}, jsx("u", {}, "c"))] }),
  fragment: () => ({ x: jsx(Fragment, {}, jsx("i", {}, "f"), "g") }),
  escaped: () => ({ x: raw("<s>raw</s>") }),
  portal: () => ({ x: createPortal(jsx("b", {}, "in portal"), document.getElementById("target")) }),
  counter: () => ({ n: 0 }),
  // Nodes built by Hono's client runtime are plain objects (hono/jsx/dom).
  domRuntimeNode: () => ({ x: domRuntime.jsx("i", { children: "dom-rt" }) }),
  domIntrinsic: () => ({ x: domRuntime.jsx("img", { src: "y" }) }),
  domCreateElement: () => ({ x: createElement("b", null, "ce") }),
  domArray: () => ({ x: [domRuntime.jsx("i", { children: "a" }), "-", domRuntime.jsx("u", { children: "b" })] }),
  domFragment: () => ({ x: domRuntime.jsx(domRuntime.Fragment, { children: [domRuntime.jsx("i", { children: "f" }), "g"] }) }),
  domRefNull: () => ({ x: domRuntime.jsx("i", { ref: null, children: "n" }) }),
  domRefNullKey: () => ({ x: domRuntime.jsx("i", { ref: null, children: "n" }, "k") }),
  sequenceData: () => ({ x: "VALUE", c: true }),
  domRef: () => ({ x: domRuntime.jsx("i", { children: "r", ref: () => {} }) }),
  cloneOfClassNode: () => ({ x: cloneElement(jsx("i", {}, "cl"), {}) }),
  // Forged: everything JSON can carry, in the shapes the client runtime builds.
  forgedKeyRef: () => ({ x: JSON.parse('{"tag":"img","type":"img","props":{"src":"x","onerror":"alert(1)"},"key":null,"ref":null}') }),
  forgedRefObjects: () => ({ x: JSON.parse('{"tag":"img","type":"img","props":{"onerror":"alert(1)","ref":{"current":null}},"key":null,"ref":{"current":null}}') }),
  forgedRefNull: () => ({ x: JSON.parse('{"tag":"img","type":"img","props":{"onerror":"alert(1)","ref":null},"key":null,"ref":null}') }),
  // A lone placeholder as a branch, loop, body or render-prop value.
  ifData: () => ({ c: true, x: DATA }),
  elseData: () => ({ c: false, x: DATA }),
  forData: () => ({ list: [DATA, "t"] }),
  componentBody: () => ({ x: DATA, Child: (p) => jsx("div", {}, (() => { const c = p.content ?? p.children; return typeof c === "function" ? c() : c; })()) }),
  renderProp: () => ({ Child: (p) => jsx("div", {}, (p.content ?? p.children)(DATA)) }),
  componentBodyNode: () => ({ x: jsx("i", {}, "kid"), Child: (p) => jsx("div", {}, (() => { const c = p.content ?? p.children; return typeof c === "function" ? c() : c; })()) }),
  ifZero: () => ({ c: true, x: 0 }),
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
const { jsx, Fragment } = await import("hono/jsx");
const domRuntime = await import("hono/jsx/dom/jsx-runtime");
const { createElement, cloneElement } = await import("hono/jsx/dom");
const { raw } = await import("hono/html");
${INPUTS}
const cases = JSON.parse(process.argv[2]);
const out = {};
for (const { name, file, input } of cases) {
  const result = { errors: [] };
  const attempt = (fn) => { try { return fn(); } catch (error) { result.errors.push(String(error && error.message)); } };
  const mod = await import(file);
  const props = inputs[input]();
  const client = document.createElement("div");
  document.body.append(client);
  attempt(() => render(jsx(mod.default, props), client));
  const setN = globalThis.__setN;
  result.client = client.innerHTML;
  result.injected = client.querySelectorAll("img, [onerror]").length;
  result.server = attempt(() => String(renderToString(jsx(mod.default, inputs[input]())))) ?? "";
  result.target = document.getElementById("target").innerHTML;
  if (name === "counter") {
    await new Promise((r) => setTimeout(r, 20));
    setN(5);
    await new Promise((r) => setTimeout(r, 50));
    result.afterUpdate = client.innerHTML;
    setN({ tag: "img", props: { onerror: "x" } });
    await new Promise((r) => setTimeout(r, 50));
    result.afterObject = client.innerHTML;
    result.injectedAfterObject = client.querySelectorAll("img, [onerror]").length;
  }
  out[name] = result;
}
console.log(JSON.stringify(out));
`;

interface CaseSpec {
  source: string;
  input: string;
}

const CASES: Record<string, CaseSpec> = {
  data: { source: "<p>${input.x}</p>", input: "data" },
  dataArray: { source: "<p>${input.x}</p>", input: "dataArray" },
  forgedPortal: { source: "<p>${input.x}</p>", input: "forgedPortal" },
  toString: { source: "<p>${input.x}</p>", input: "toString" },
  valueOf: { source: "<p>${input.x}</p>", input: "valueOf" },
  nullProto: { source: "<p>${input.x}</p>", input: "nullProto" },
  primitives: {
    source:
      "<p>${input.a}|${input.b}|${input.c}|${input.d}|${input.e}|${input.f}</p>",
    input: "primitives",
  },
  node: { source: "<p>${input.x}</p>", input: "node" },
  nodes: { source: "<p>${input.x}</p>", input: "nodes" },
  fragment: { source: "<p>${input.x}</p>", input: "fragment" },
  escaped: { source: "<p>${input.x}</p>", input: "escaped" },
  portal: { source: "<p>${input.x}</p>", input: "portal" },
  counter: { source: "<button>${input.n}</button>", input: "counter" },
  domRuntimeNode: { source: "<p>${input.x}</p>", input: "domRuntimeNode" },
  domIntrinsic: { source: "<p>${input.x}</p>", input: "domIntrinsic" },
  domCreateElement: { source: "<p>${input.x}</p>", input: "domCreateElement" },
  domArray: { source: "<p>${input.x}</p>", input: "domArray" },
  domFragment: { source: "<p>${input.x}</p>", input: "domFragment" },
  domRefNull: { source: "<p>${input.x}</p>", input: "domRefNull" },
  domRefNullKey: { source: "<p>${input.x}</p>", input: "domRefNullKey" },
  sequenceBody: { source: "<p>${(0, input.x)}</p>", input: "sequenceData" },
  sequenceBare: { source: "<p>${0, input.x}</p>", input: "sequenceData" },
  sequenceIf: {
    source: "<p><if=input.c>${(0, input.x)}</if></p>",
    input: "sequenceData",
  },
  domRef: { source: "<p>${input.x}</p>", input: "domRef" },
  cloneOfClassNode: { source: "<p>${input.x}</p>", input: "cloneOfClassNode" },
  forgedKeyRef: { source: "<p>${input.x}</p>", input: "forgedKeyRef" },
  forgedRefObjects: { source: "<p>${input.x}</p>", input: "forgedRefObjects" },
  forgedRefNull: { source: "<p>${input.x}</p>", input: "forgedRefNull" },
  ifLone: { source: "<p><if=input.c>${input.x}</if></p>", input: "ifData" },
  elseLone: {
    source: "<p><if=input.c>a</if><else>${input.x}</else></p>",
    input: "elseData",
  },
  forLone: {
    source: "<ul><for|i| of=input.list>${i}</for></ul>",
    input: "forData",
  },
  componentBody: {
    source: "<const/C=input.Child/>\n<C>${input.x}</C>",
    input: "componentBody",
  },
  renderProp: {
    source: "<const/C=input.Child/>\n<C|v|>${v}</C>",
    input: "renderProp",
  },
  componentBodyNode: {
    source: "<const/C=input.Child/>\n<C>${input.x}</C>",
    input: "componentBodyNode",
  },
  ifZero: { source: "<p><if=input.c>${input.x}</if></p>", input: "ifZero" },
};

interface Result {
  client: string;
  server: string;
  target: string;
  injected: number;
  errors: string[];
  afterUpdate?: string;
  afterObject?: string;
  injectedAfterObject?: number;
}
let results: Record<string, Result>;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "mx-hono-text-object-"));
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
  const cases = Object.entries(CASES).map(([name, spec]) => {
    const file = join(scratch, `${name}.tsx`);
    writeFileSync(file, compileHonoMx(spec.source, file).code);
    if (name === "counter") {
      // The compiled view is stateless; this wrapper owns the state the way a
      // component does, and re-renders the view when it changes.
      const wrapper = join(scratch, "counter-app.tsx");
      writeFileSync(
        wrapper,
        [
          "/** @jsxImportSource hono/jsx */",
          'import { useState } from "hono/jsx";',
          'import View from "./counter.tsx";',
          "export default function App() {",
          "  const [n, setN] = useState<any>(0);",
          "  (globalThis as any).__setN = setN;",
          "  return <View n={n} />;",
          "}",
        ].join("\n"),
      );
      return { name, file: wrapper, input: spec.input };
    }
    return { name, file, input: spec.input };
  });
  const entry = join(scratch, "run.mjs");
  writeFileSync(entry, RUNNER);
  results = JSON.parse(
    execFileSync("bun", [entry, JSON.stringify(cases)], {
      encoding: "utf8",
      cwd: scratch,
    }),
  ) as Record<string, Result>;
}, 120_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const at = (name: string): Result => results[name] as Result;

const html = (value: string): string => value.replace(/&gt;/g, ">");

describe("JSON-shaped data in a text placeholder (Hono client and server)", () => {
  it("prints a { tag, props } object as [object Object], never an element", () => {
    expect(at("data").errors).toEqual([]);
    expect(at("data").client).toBe("<p>[object Object]</p>");
    expect(at("data").injected).toBe(0);
    expect(html(at("data").server)).toBe("<p>[object Object]</p>");
  });
  it("maps an array that holds data objects", () => {
    expect(at("dataArray").client).toBe(
      "<p>a[object Object][object Object]</p>",
    );
    expect(at("dataArray").injected).toBe(0);
    expect(html(at("dataArray").server)).toBe(
      "<p>a[object Object][object Object]</p>",
    );
  });
  it("does not take a forged portal for a real one", () => {
    expect(at("forgedPortal").errors).toEqual([]);
    expect(at("forgedPortal").client).toBe("<p>[object Object]</p>");
  });
  it("honours an own toString, escaped", () => {
    expect(at("toString").client).toBe("<p>&lt;b&gt;own&lt;/b&gt;</p>");
    expect(html(at("toString").server)).toBe("<p>&lt;b>own&lt;/b></p>");
  });
  it("honours an own valueOf like Marko's value + '', escaped", () => {
    expect(at("valueOf").client).toBe("<p>&lt;u&gt;v&lt;/u&gt;</p>");
    expect(html(at("valueOf").server)).toBe("<p>&lt;u>v&lt;/u></p>");
  });
  it("stringifies a null-prototype object", () => {
    expect(at("nullProto").client).toBe("<p>[object Object]</p>");
  });
});

describe("what the renderer made is left alone (Hono client and server)", () => {
  it("renders primitives as before", () => {
    expect(at("primitives").errors).toEqual([]);
    expect(at("primitives").client).toBe("<p>s&lt;|0||||1x</p>");
    expect(html(at("primitives").server)).toBe("<p>s&lt;|0||||1x</p>");
  });
  it("renders a Hono node", () => {
    expect(at("node").client).toBe("<p><i>node</i></p>");
    expect(at("node").server).toBe("<p><i>node</i></p>");
  });
  it("renders an array of nodes and text", () => {
    expect(at("nodes").client).toBe("<p><i>a</i>-<b><u>c</u></b></p>");
    expect(at("nodes").server).toBe("<p><i>a</i>-<b><u>c</u></b></p>");
  });
  it("renders a fragment", () => {
    expect(at("fragment").client).toBe("<p><i>f</i>g</p>");
    expect(at("fragment").server).toBe("<p><i>f</i>g</p>");
  });
  it("keeps raw() markup as markup on the server, as before the guard", () => {
    // (`hono/jsx/dom` cannot render a raw() string at all, guarded or not.)
    expect(at("escaped").server).toBe("<p><s>raw</s></p>");
  });
  it("renders a real portal into its container", () => {
    expect(at("portal").errors).toEqual([]);
    expect(at("portal").target).toContain("<b>in portal</b>");
  });
});

describe("nodes built by hono/jsx/dom are left alone (Hono client)", () => {
  it("renders a node from the dom jsx-runtime, an intrinsic tag and a ref", () => {
    expect(at("domRuntimeNode").client).toBe("<p><i>dom-rt</i></p>");
    expect(at("domIntrinsic").client).toBe('<p><img src="y"></p>');
    expect(at("domRef").client).toBe("<p><i>r</i></p>");
  });
  it("renders createElement, cloneElement, a dom fragment and an array of dom nodes", () => {
    expect(at("domCreateElement").client).toBe("<p><b>ce</b></p>");
    expect(at("cloneOfClassNode").client).toBe("<p><i>cl</i></p>");
    expect(at("domFragment").client).toBe("<p><i>f</i>g</p>");
    expect(at("domArray").client).toBe("<p><i>a</i>-<u>b</u></p>");
  });
  it("renders a dom node with ref={null}, and prints one that also has a key as text", () => {
    expect(at("domRefNull").client).toBe("<p><i>n</i></p>");
    // Not recognised: null equality is what JSON can forge. Documented limit.
    expect(at("domRefNullKey").client).toBe("<p>[object Object]</p>");
  });
  it("does not take JSON shaped like a dom node for one", () => {
    for (const name of ["forgedKeyRef", "forgedRefObjects", "forgedRefNull"]) {
      expect(at(name).errors).toEqual([]);
      expect(at(name).client).toBe("<p>[object Object]</p>");
      expect(at(name).injected).toBe(0);
    }
  });
});

describe("a lone placeholder in a branch, loop or body (Hono client and server)", () => {
  it("prints data as text in <if>, <else> and <for>", () => {
    expect(at("ifLone").client).toBe("<p>[object Object]</p>");
    expect(at("ifLone").injected).toBe(0);
    expect(html(at("ifLone").server)).toBe("<p>[object Object]</p>");
    expect(at("elseLone").client).toBe("<p>[object Object]</p>");
    expect(at("elseLone").injected).toBe(0);
    expect(html(at("elseLone").server)).toBe("<p>[object Object]</p>");
    expect(at("forLone").client).toBe("<ul>[object Object]t</ul>");
    expect(at("forLone").injected).toBe(0);
    expect(html(at("forLone").server)).toBe("<ul>[object Object]t</ul>");
  });
  it("prints data as text in a component body and a render-prop body", () => {
    expect(at("componentBody").client).toBe("<div>[object Object]</div>");
    expect(at("componentBody").injected).toBe(0);
    expect(html(at("componentBody").server)).toBe("<div>[object Object]</div>");
    expect(at("renderProp").client).toBe("<div>[object Object]</div>");
    expect(at("renderProp").injected).toBe(0);
    expect(html(at("renderProp").server)).toBe("<div>[object Object]</div>");
  });
  it("still renders a real node and a falsy zero there", () => {
    expect(at("componentBodyNode").client).toBe("<div><i>kid</i></div>");
    expect(at("componentBodyNode").server).toBe("<div><i>kid</i></div>");
    expect(at("ifZero").client).toBe("<p>0</p>");
    expect(at("ifZero").server).toBe("<p>0</p>");
  });
});

describe("a comma expression in a placeholder is one argument (Hono client and server)", () => {
  it("renders the last operand, as Marko does", () => {
    for (const name of ["sequenceBody", "sequenceBare", "sequenceIf"]) {
      expect(at(name).errors).toEqual([]);
      expect(at(name).client).toBe("<p>VALUE</p>");
      expect(at(name).server).toBe("<p>VALUE</p>");
    }
  });
});

describe("a state update still re-renders the text (Hono client)", () => {
  it("shows the new value, then data as text", () => {
    expect(at("counter").client).toBe("<button>0</button>");
    expect(at("counter").afterUpdate).toBe("<button>5</button>");
    expect(at("counter").afterObject).toBe("<button>[object Object]</button>");
    expect(at("counter").injectedAfterObject).toBe(0);
  });
});
