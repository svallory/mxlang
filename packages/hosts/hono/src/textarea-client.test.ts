/**
 * `<textarea value=x/>` renders as content and a leading newline is doubled
 * for the server only (the HTML parser drops a textarea's first newline, so
 * Marko writes two). `hono/jsx/dom`'s `render` accepts the emitted module's
 * nodes and sets the text through the DOM, where a doubled newline would show
 * as a second one: this test pins that the client render keeps `value === x`
 * while the string renderer's markup carries the extra newline.
 *
 * The same harness runs an element reference (`<div/el>`): `hono/jsx/dom`
 * calls the callback `ref` the emitter passes on the client, so a handler's
 * `el()` reads the rendered element. (The server render, which gets
 * `undefined` for that `ref`, is the region parity row in `region.test.ts`.)
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

describe("an element reference (`<div/el>`) is the rendered element in a handler (Hono)", () => {
  const SOURCES = {
    base: '<div/el/><button onClick() { el().dataset.hit = "1" }>go</button>',
    rows: "<for|n| of=[1, 2]><div/el/><button onClick() { el().dataset.hit = String(n) }>go</button></for>",
    authoredRef:
      '<div/el ref=input.r/><button onClick() { el().dataset.hit = "1" }>go</button>',
    // A literal dynamic tag is a native tag to Marko: `el` is the element.
    dynamic:
      '<${"my-el"}/el/><button onClick() { el().dataset.hit = "1" }>go</button>',
    dynamicAuthoredRef:
      '<${"my-el"}/el ref=input.r/><button onClick() { el().dataset.hit = "1" }>go</button>',
    // An element body is its own scope: `input` is the element inside it and
    // the template's input outside it.
    nestedInput:
      '<p>${typeof input.r}</p><div><div/input/><button onClick() { input().dataset.hit = "1" }>go</button></div>',
    // Two element bodies each bind `el`: each body is a scope of its own, so
    // each handler reaches its own element.
    twoBodies:
      '<div><div/el/><button onClick() { el().dataset.hit = "1" }>a</button></div><div><div/el/><button onClick() { el().dataset.hit = "2" }>b</button></div>',
  } as const;
  const files = {} as Record<keyof typeof SOURCES, string>;

  // One client process for every case: render, click the given button, read
  // the markup back. The globals are set before `hono/jsx/dom` loads.
  const REF_CLIENT = `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
const { render } = await import("hono/jsx/dom");
const { jsx } = await import("hono/jsx");
const out = {};
for (const [name, file, click] of JSON.parse(process.argv[2])) {
  const mod = await import(file);
  const root = document.createElement("div");
  document.body.append(root);
  let received = null;
  render(jsx(mod.default, { r: (node) => { if (node) received = node; } }), root);
  root.querySelectorAll("button")[click].click();
  out[name] = { html: root.innerHTML };
  // Only the authored-ref cases read the \`r\` prop.
  if (name === "authoredRef") out[name].refIsDiv = received === root.querySelector("div");
  if (name === "dynamicAuthoredRef") out[name].refIsMyEl = received === root.querySelector("my-el");
}
console.log(JSON.stringify(out));
`;

  beforeAll(() => {
    for (const [name, source] of Object.entries(SOURCES)) {
      const file = join(scratch, `${name}.tsx`);
      writeFileSync(file, compileHonoMx(source, file).code);
      files[name as keyof typeof SOURCES] = file;
    }
  });

  it("a click reaches the element, per row in a <for>, with an authored ref composed, named input in an element body, and in two bodies binding the same name", () => {
    const result = run(
      REF_CLIENT,
      JSON.stringify([
        ["base", files.base, 0],
        ["rows", files.rows, 1],
        ["authoredRef", files.authoredRef, 0],
        ["dynamic", files.dynamic, 0],
        ["dynamicAuthoredRef", files.dynamicAuthoredRef, 0],
        ["nestedInput", files.nestedInput, 0],
        ["twoBodies", files.twoBodies, 1],
      ]),
    );
    expect(result).toEqual({
      base: {
        html: '<div data-hit="1"></div><button>go</button>',
      },
      rows: {
        html: '<div></div><button>go</button><div data-hit="2"></div><button>go</button>',
      },
      authoredRef: {
        html: '<div data-hit="1"></div><button>go</button>',
        refIsDiv: true,
      },
      dynamic: {
        html: '<my-el data-hit="1"></my-el><button>go</button>',
      },
      dynamicAuthoredRef: {
        html: '<my-el data-hit="1"></my-el><button>go</button>',
        refIsMyEl: true,
      },
      nestedInput: {
        html: '<p>function</p><div><div data-hit="1"></div><button>go</button></div>',
      },
      twoBodies: {
        html: '<div><div></div><button>a</button></div><div><div data-hit="2"></div><button>b</button></div>',
      },
    });
  }, 30_000);
});
