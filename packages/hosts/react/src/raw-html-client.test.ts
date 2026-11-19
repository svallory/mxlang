// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A literal `innerHTML=` or `outerHTML=`, and a spread key of either name,
 * must not write markup on a React client render or hydration: React assigns
 * `innerHTML`/`outerHTML` as DOM properties, and `dangerouslySetInnerHTML` as
 * `innerHTML`. Stock Marko prints them as escaped attributes. The emitter
 * writes them under their lowercase name, which is no DOM property, so React
 * calls `setAttribute` and the value stays text. Run in jsdom, in a scratch
 * script (the DOM globals must exist before `react` loads). The same client
 * render clicks every button once, so an element reference (`<div/el>`) read
 * in a handler is checked here too.
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
import { compileReactMx } from "./index.ts";

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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const warnings = [];
console.error = console.warn = (...args) => warnings.push(args.join(" "));
// The running case's errors. React hands a handler's error to the global
// \`reportError\`, which react-dom binds once, when it loads: route it (and
// anything else reported globally) to the case that raised it.
let current = [];
const report = (error) => current.push(String(error && error.message));
globalThis.reportError = report;
process.on("uncaughtException", report);
window.addEventListener("error", (event) => report(event.error ?? event));
const { createElement } = await import("react");
const { createRoot, hydrateRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { renderToString } = await import("react-dom/server");
const cases = JSON.parse(process.argv[2]);
const out = [];
for (const { file, input } of cases) {
  const errors = [];
  current = errors;
  const row = { client: "", hydrated: "", elements: 0, injected: 0, errors };
  try {
    const mod = await import(file);
    const client = document.createElement("div");
    document.body.append(client);
    const rootOptions = { onUncaughtError: report, onRecoverableError: () => {} };
    const attempt = (fn) => { try { fn(); } catch (error) { report(error); } };
    attempt(() => flushSync(() => createRoot(client, rootOptions).render(createElement(mod.default, input))));
    attempt(() => { for (const button of client.querySelectorAll("button")) button.click(); });
    let server = "";
    attempt(() => { server = renderToString(createElement(mod.default, input)); });
    const hydrated = document.createElement("div");
    hydrated.innerHTML = server;
    document.body.append(hydrated);
    attempt(() => flushSync(() => { hydrateRoot(hydrated, createElement(mod.default, input), rootOptions); }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    row.client = client.innerHTML;
    row.hydrated = hydrated.innerHTML;
    row.elements = [...client.querySelectorAll("b"), ...hydrated.querySelectorAll("b")].length;
    row.injected = [...client.querySelectorAll("img, i, [onerror]"), ...hydrated.querySelectorAll("img, i, [onerror]")].length;
  } catch (error) {
    report(error);
  }
  out.push(row);
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
  elementRef:
    '<section><div/el/><button onClick() { el().dataset.hit = "1" }>go</button></section>',
  throwingHandler:
    '<section><button onClick() { throw new Error("boom") }>go</button></section>',
  dynamicElementRef:
    '<section><${"my-el"}/el/><button onClick() { el().dataset.hit = "1" }>go</button></section>',
  nestedInputRef:
    '<section><div><div/input/><button onClick() { input().dataset.hit = "1" }>go</button></div><p>${input.tag}</p></section>',
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
  scratch = mkdtempSync(join(tmpdir(), "mx-react-raw-html-client-"));
  mkdirSync(join(scratch, "node_modules"));
  for (const name of ["react", "react-dom", "jsdom"]) {
    let dir = dirname(require.resolve(name));
    while (basename(dir) !== name) dir = dirname(dir);
    symlinkSync(dir, join(scratch, "node_modules", name), "dir");
  }
  writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
    }),
  );
  const cases = Object.entries(SOURCES).map(([name, source]) => {
    const file = join(scratch, `${name}.tsx`);
    writeFileSync(file, compileReactMx(source, file).code);
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

describe("React client render and hydration never write markup from innerHTML or outerHTML", () => {
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

  it("is refused by React itself, which throws on an object child", () => {
    expect(results.objectChild.errors.join(" ")).toContain(
      "Objects are not valid as a React child",
    );
  });
});

describe("an element reference (`<div/el>`) on React", () => {
  it("is the rendered element in a click handler", () => {
    expect(results.elementRef.client).toBe(
      '<section><div data-hit="1"></div><button>go</button></section>',
    );
    expect(results.elementRef.errors).toEqual([]);
  });

  // A literal dynamic tag is a native tag to Marko: `el` is the element.
  it("is the rendered element on a literal dynamic tag", () => {
    expect(results.dynamicElementRef.client).toBe(
      '<section><my-el data-hit="1"></my-el><button>go</button></section>',
    );
    expect(results.dynamicElementRef.errors).toEqual([]);
  });

  // An element body is its own scope: `input` is the element inside it and
  // the template's input outside it.
  it("named input in an element body, beside the template input", () => {
    expect(results.nestedInputRef.client).toBe(
      '<section><div><div data-hit="1"></div><button>go</button></div><p>article</p></section>',
    );
    expect(results.nestedInputRef.errors).toEqual([]);
  });
});

describe("the client script's per-case guard", () => {
  it("records a handler's error in its own row only", () => {
    expect(results.throwingHandler.errors).toContain("boom");
    expect(results.throwingHandler.client).toBe(
      "<section><button>go</button></section>",
    );
  });
});
