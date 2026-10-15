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
 * A `${expr}` holding a plain object on Solid's server renderer.
 *
 * Solid 2's SSR nodes are unbranded `{ t: ... }` object literals and
 * `@solidjs/web` writes a node's `t` unescaped, so an object that came from
 * JSON (`{ t: "<b>x</b>" }`) is indistinguishable from a rendered node and is
 * written as markup. Stock Marko prints `[object Object]`. No host-side guard
 * can fix this without also stringifying real nodes (`${props.children}`, a
 * render-prop return, a component call), which is what the first draft did, so
 * the fix has to come from the runtime: bead
 * `mx-solid-ssr-object-child-raw-html` (blocked on upstream, see
 * `scratch/reports/solid-ssr-node-brand-issue.md`).
 *
 * The first block pins what must keep working under any future fix: real
 * nodes reaching a placeholder render as markup. The second block is the
 * skipped repro of the open bead: remove the `.skip` when the runtime brands
 * its nodes.
 */
const CASES: Record<string, string> = {
  children: `
function Layout(props: { children: unknown }) {
  return <main>\${props.children}</main>;
}
export function App() {
  return <Layout><p>body &amp; <i>more</i></p></Layout>;
}`,
  renderPropReturn: `
function Frame(props: { render: () => unknown }) {
  return <div>\${props.render()}</div>;
}
export function App() {
  const render = () => <b>built</b>;
  return <Frame render=render/>;
}`,
  componentCall: `
function Greeting(props: { name: string }) {
  return <em>hi \${props.name}</em>;
}
export function App() {
  return <div>\${Greeting({ name: "a<b" })}</div>;
}`,
  forged: `
export function App() {
  const x = { t: "<b>x</b>" };
  return <div>\${x}</div>;
}`,
  forgedArray: `
export function App() {
  const x = [{ t: "<b>x</b>" }, "a"];
  return <div>\${x}</div>;
}`,
};

type Outcome = { html?: string; error?: string };
const outcomes: Record<string, Outcome> = {};

function toModule(source: string): string {
  const jsx = generate(parseSolid(source, "fixture.solid.mx")).code;
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
  const dir = mkdtempSync(join(packageRoot, ".text-object-ssr-tmp-"));
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

const get = (name: string): Outcome =>
  outcomes[name] ?? { error: `missing ${name}` };

describe("Solid SSR: a rendered node in a text placeholder", () => {
  it("renders children, a render-prop return and a component call as markup", () => {
    expect(get("children").html).toBe(
      "<main><p>body &amp; <i>more</i></p></main>",
    );
    expect(get("renderPropReturn").html).toBe("<div><b>built</b></div>");
    expect(get("componentCall").html).toBe("<div><em>hi a&lt;b</em></div>");
  });
});

describe("Solid SSR: a plain data object in a text placeholder", () => {
  // mx-solid-ssr-object-child-raw-html: blocked on a runtime that brands its nodes.
  it.skip("mx-solid-ssr-object-child-raw-html: prints { t } data as [object Object]", () => {
    const { html } = get("forged");
    expect(html).toContain("[object Object]");
    expect(html).not.toContain("<b>");
  });
  it.skip("mx-solid-ssr-object-child-raw-html: prints an array holding { t } data as text", () => {
    const { html } = get("forgedArray");
    expect(html).toContain("[object Object]");
    expect(html).not.toContain("<b>");
  });
  it.todo(
    "mx-solid-ssr-object-child-raw-html: a { t: [...], h: [fn] } object in a text placeholder is text, not a hole",
  );
});
