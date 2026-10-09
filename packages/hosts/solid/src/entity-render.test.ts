import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const text = "&lt;b&gt;x&lt;/b&gt; &amp;copy; &copy 2026 &check; &#xD800;";
const decoded = "<b>x</b> &copy; © 2026 ✓ �";

// Marko 6.3.51 live-rendered references, compared with parse5 in the round-2
// probe. Tags are checked as well as text: accidental live <b> markup can
// otherwise look like an entity-decoding success. Extra positions below pin
// Solid's own component/fallback conventions using the same literal text.
const cases = [
  ["intrinsic", `<div>${text}</div>`, decoded, ["div"]],
  ["if body", `<div><if=true>${text}</if></div>`, decoded, ["div"]],
  [
    "else body",
    `<div><if=false>no</if><else>${text}</else></div>`,
    decoded,
    ["div"],
  ],
  [
    "nested if",
    `<div><if=true><if=true>${text}</if></if></div>`,
    decoded,
    ["div"],
  ],
  ["for body", `<div><for|i| of=[1]>${text}</for></div>`, decoded, ["div"]],
  [
    "for in body",
    `<div><for|k,v| in={a:1}>${text}</for></div>`,
    decoded,
    ["div"],
  ],
  [
    "range body",
    `<div><for|i| from=0 to=1>${text}</for></div>`,
    decoded + decoded,
    ["div"],
  ],
  [
    "nested intrinsic in if",
    `<div><if=true><span>${text}</span></if></div>`,
    decoded,
    ["div", "span"],
  ],
  [
    "nested intrinsic in for",
    `<div><for|i| of=[1]><span>${text}</span></for></div>`,
    decoded,
    ["div", "span"],
  ],
  [
    "fragment siblings",
    `<div>a</div>${text}<span>z</span>`,
    `a${decoded}z`,
    ["div", "span"],
  ],
  [
    "mixed placeholder",
    `<div><if=true>&lt;b&gt;${'${"!"}'}&lt;/b&gt;</if></div>`,
    "<b>!</b>",
    ["div"],
  ],
  [
    "try body",
    `<div><try>${text}<@catch>x</@catch></try></div>`,
    decoded,
    ["div"],
  ],
  ["component children", `<Row>${text}</Row>`, decoded, ["section"]],
  [
    "switch match",
    `<div><if=false>no</if><else-if=false>no</else-if><else-if=true>${text}</else-if><else>no</else></div>`,
    decoded,
    ["div"],
  ],
  [
    "switch fallback",
    `<div><if=false>no</if><else-if=false>no</else-if><else-if=false>no</else-if><else>${text}</else></div>`,
    decoded,
    ["div"],
  ],
] as const;

function render(source: string, generate: "ssr" | "dom") {
  const compiled = compileSolidMx(source, {
    filename: "fixture.solid.mx",
    moduleBindings: new Set(["Row"]),
  });
  const jsx = `${compiled.hoistedImports.map((entry) => entry.code).join("\n")}
function Row(props) { return <section>{props.children}</section>; }
export function App() { return <>${compiled.code}</>; }`;
  const output = transformSync(jsx, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate, hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!output?.code) throw new Error("Solid emitted no fixture code");
  const dir = mkdtempSync(join(packageRoot, ".entity-render-tmp-"));
  try {
    writeFileSync(join(dir, "app.mjs"), output.code);
    const runner = join(dir, "run.mjs");
    writeFileSync(
      runner,
      `
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>");
for (const name of ["window", "document", "HTMLElement", "Node", "Text", "Comment", "DocumentFragment"])
  globalThis[name] = dom.window[name];
const web = await import("@solidjs/web");
const { App } = await import("./app.mjs");
const container = document.createElement("main");
${generate === "ssr" ? "container.innerHTML = web.renderToString(() => App());" : "document.body.appendChild(container); web.render(() => App(), container);"}
process.stdout.write(JSON.stringify({ text: container.textContent,
  tags: [...container.querySelectorAll("*")].map(el => el.localName) }));
`,
    );
    return JSON.parse(
      execFileSync(
        "bun",
        [
          "run",
          ...(generate === "dom" ? ["--conditions=browser"] : []),
          runner,
        ],
        {
          cwd: packageRoot,
          encoding: "utf8",
          timeout: 15_000,
        },
      ),
    ) as { text: string; tags: string[] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(["ssr", "dom"] as const)(
  "authored entities through real Solid %s",
  (generate) => {
    it.each(cases)(
      "renders %s as literal text, decoded and escaped once",
      (_name, source, expected, tags) => {
        expect(render(source, generate)).toEqual({ text: expected, tags });
      },
      20_000,
    );
  },
);
