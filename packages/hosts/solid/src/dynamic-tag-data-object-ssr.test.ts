// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import generate from "@babel/generator";
import typescriptPreset from "@babel/preset-typescript";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { beforeAll, describe, expect, it } from "vitest";
import { parseSolid } from "./bridge/test-helpers.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

/**
 * A dynamic tag whose value is data, on Solid's server renderer.
 *
 * `<${x}/>` with a plain object renders nothing in stock Marko 6.4.4 (and
 * `<hi></hi>` for `"hi"`). Solid's emit already matches: a value that is neither
 * a non-empty string nor a function has no renderer, so only the tag's own body
 * renders. This pins it for the shapes that hurt the JSX hosts: JSON in the
 * `{ tag, props }` shape, the `{ t }` shape Solid's server nodes have, a
 * null-prototype object, and a data attribute tag (`{ content }`, refused).
 */
const DATA = '{ tag: "img", props: { src: "x", onerror: "alert(1)" } }';
const source = (decl: string, body = "<${x}/>"): string => `
export function App() {
  ${decl}
  return <div>${body}</div>;
}`;
const CASES: Record<string, string> = {
  data: source(`const x = ${DATA};`),
  dataType: source(
    'const x = { type: "img", props: { src: "x", onerror: "alert(1)" } };',
  ),
  forgedT: source('const x = { t: "<b>x</b>" };'),
  nullProto: source(`const x = Object.assign(Object.create(null), ${DATA});`),
  forgedReact: source(
    'const x = { $$typeof: "react.element", type: "img", props: { onerror: "alert(1)" } };',
  ),
  dataBody: source(`const x = ${DATA};`, "<${x}>body</>"),
  string: source('const x = "b";'),
  stringBody: source('const x = "b";', "<${x}>body</>"),
  component: source("const x = () => <em>c</em>;"),
  nullValue: source("const x = null;"),
  zero: source("const x = 0;"),
  falseValue: source("const x = false;"),
  nullBody: source("const x = null;", "<${x}>body</>"),
  contentData: source(`const x = { content: ${DATA} };`),
};

type Outcome = { html?: string; error?: string };
const outcomes: Record<string, Outcome> = {};

function toModule(src: string): string {
  const jsx = generate(parseSolid(src, "fixture.solid.mx")).code;
  const out = transformSync(jsx, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, { isTSX: true, allExtensions: true }]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error("no output");
  return out.code;
}

beforeAll(() => {
  const dir = mkdtempSync(join(packageRoot, ".dynamic-data-ssr-tmp-"));
  try {
    const names = Object.keys(CASES);
    names.forEach((name, index) => {
      writeFileSync(
        join(dir, `app${index}.mjs`),
        toModule(CASES[name] as string),
      );
    });
    writeFileSync(
      join(dir, "run.mjs"),
      [
        'import { renderToString } from "@solidjs/web";',
        "const out = {};",
        `const names = ${JSON.stringify(names)};`,
        "for (let i = 0; i < names.length; i++) {",
        "  try {",
        "    const { App } = await import(`./app${i}.mjs`);",
        "    out[names[i]] = { html: renderToString(() => App()) };",
        "  } catch (e) { out[names[i]] = { error: String(e && e.message) }; }",
        "}",
        "process.stdout.write(JSON.stringify(out));",
      ].join("\n"),
    );
    const stdout = execFileSync("bun", ["run", join(dir, "run.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    Object.assign(outcomes, JSON.parse(stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 240_000);

/** Solid numbers its server elements (`_hk=10`) even when it is not hydrating. */
const get = (name: string): Outcome => {
  const outcome = outcomes[name] ?? { error: `missing ${name}` };
  return outcome.html === undefined
    ? outcome
    : { html: outcome.html.replace(/ _hk=\d+ ?/g, "") };
};

describe("Solid SSR: data in a dynamic tag renders nothing", () => {
  it.each([
    "data",
    "dataType",
    "nullProto",
    "forgedReact",
    "nullValue",
    "zero",
    "falseValue",
  ])("%s", (name) => {
    expect(get(name).error).toBeUndefined();
    expect(get(name).html).toBe("<div></div>");
  });
  it("a body still renders next to data and a falsy value", () => {
    expect(get("dataBody").html).toBe("<div>body</div>");
    expect(get("nullBody").html).toBe("<div>body</div>");
  });
  it("refuses an object that carries content, as a data attribute tag", () => {
    expect(get("contentData").error).toMatch(/data attribute tag/);
  });
});

describe("Solid SSR: a { t } object in a dynamic tag", () => {
  // Solid 2's server nodes are unbranded `{ t }` literals that `@solidjs/web`
  // writes unescaped, so JSON in that shape cannot be told from a rendered node
  // (`<${props.children}/>` is one). The same upstream block as a text
  // placeholder: bead mx-solid-ssr-object-child-raw-html.
  it.skip("mx-solid-ssr-object-child-raw-html: renders { t } data as nothing", () => {
    expect(get("forgedT").html).toBe("<div></div>");
  });
});

describe("Solid SSR: what a dynamic tag renders as before", () => {
  it("renders a string as an element and a function as a component", () => {
    expect(get("string").html).toBe("<div><b></b></div>");
    expect(get("stringBody").html).toBe("<div><b>body</b></div>");
    expect(get("component").html).toBe("<div><em>c</em></div>");
  });
});
