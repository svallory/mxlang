// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
/**
 * A `<for step=...>` mapper's own parameter is in scope for the author's own
 * `from`/`step` expressions: the row value is derived from the index *inside*
 * Solid's `<Repeat>` callback, so `<Repeat count={…}>{(mxIndex) => { const i
 * = (mxIndex) + mxIndex * (2); …`. A generated `mxIndex` therefore shadowed an
 * authored binding of the same name and the loop rendered `0, 3, 6` where the
 * author wrote `10, 12, 14`.
 *
 * The *unstepped* range was never affected on this host: it becomes Solid's
 * `from=`/`count=` props, which are evaluated outside the callback. Both forms
 * are asserted here so a future refactor cannot move the `from` expression
 * back inside.
 *
 * Rendered twice: through `renderToString` (SSR codegen) and mounted into a
 * real jsdom document (DOM codegen, a live signal write, a re-check). The
 * harnesses are copied from `ssr-render.test.ts` / `client-render.test.ts`,
 * which own the long explanations of why each runs in a Bun subprocess.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import { parse, sourceBindings, unknownSourceBindings } from "@mxlang/parser";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
// Mirrors `index.test.ts`'s bridge stub: the parser hands a region plus the
// caller's options, and only `source` is read here.
// biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
const solidRegionCompile = (input: any) => compileSolidMx(input.source, input);
const SUBPROCESS_TIMEOUT_MS = 15_000;

function codegen(
  mxFragment: string,
  setup: string,
  generate: "ssr" | "dom",
): string {
  const { code, hoistedImports } = compileSolidMx(mxFragment, {
    filename: "fixture.solid.mx",
    moduleBindings: sourceBindings(setup).bindings,
    unknownModuleBindings: unknownSourceBindings(setup),
  });
  const imports = hoistedImports.map((entry) => entry.code).join("\n");
  const jsxSource = `${imports}\nimport { createSignal } from "solid-js";\nexport function App() {\n  ${setup}\n  return <ul>${code}</ul>;\n}\n`;
  const out = transformSync(jsxSource, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate, hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error("Solid babel plugin produced no code");
  return out.code;
}

/** Real `@solidjs/web` SSR render, in a Bun subprocess. */
function renderSsr(mxFragment: string, setup: string): string {
  return runSsr(codegen(mxFragment, setup, "ssr"));
}

function runSsr(code: string): string {
  const dir = mkdtempSync(join(packageRoot, ".range-names-ssr-tmp-"));
  try {
    writeFileSync(join(dir, "app.mjs"), code);
    writeFileSync(
      join(dir, "run.mjs"),
      `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
    );
    return execFileSync("bun", ["run", join(dir, "run.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Real client render into jsdom: the DOM codegen, `--conditions=browser`, one
 * signal write, then the live `innerHTML` again.
 */
function renderDom(
  mxFragment: string,
  setup: string,
  setterGlobal: string,
  mutation: string,
): string[] {
  const dir = mkdtempSync(join(packageRoot, ".range-names-dom-tmp-"));
  try {
    writeFileSync(join(dir, "app.mjs"), codegen(mxFragment, setup, "dom"));
    writeFileSync(
      join(dir, "run.mjs"),
      [
        'import { JSDOM } from "jsdom";',
        'const dom = new JSDOM("<!DOCTYPE html><body></body>");',
        "globalThis.window = dom.window;",
        "globalThis.document = dom.window.document;",
        "globalThis.HTMLElement = dom.window.HTMLElement;",
        "globalThis.Node = dom.window.Node;",
        "globalThis.Text = dom.window.Text;",
        "globalThis.Comment = dom.window.Comment;",
        "globalThis.DocumentFragment = dom.window.DocumentFragment;",
        'const { render } = await import("@solidjs/web");',
        'const { App } = await import("./app.mjs");',
        'const container = document.createElement("div");',
        "document.body.appendChild(container);",
        "render(() => App(), container);",
        "const snapshots = [container.innerHTML];",
        `globalThis.${setterGlobal}(new Function('return (' + ${JSON.stringify(mutation)} + ')')());`,
        "await new Promise((r) => setTimeout(r, 0));",
        "snapshots.push(container.innerHTML);",
        "process.stdout.write(JSON.stringify(snapshots));",
      ].join("\n"),
    );
    const output = execFileSync(
      "bun",
      ["run", "--conditions=browser", join(dir, "run.mjs")],
      { cwd: packageRoot, encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS },
    );
    return JSON.parse(output) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("<for> range bounds are not shadowed by the mapper's own counter", () => {
  it("renders a stepped range over an authored `mxIndex` (SSR)", () => {
    expect(
      renderSsr(
        `<for|i| from=mxIndex to=mxIndex+4 step=2><b>\${i}</b></for>`,
        "const mxIndex = 10;",
      ),
    ).toBe("<ul><b>10</b><b>12</b><b>14</b></ul>");
  });

  it("renders a stepped range over an authored `_` (SSR)", () => {
    expect(
      renderSsr(
        `<for|i| from=_ to=_+4 step=2><b>\${i}</b></for>`,
        "const _ = 5;",
      ),
    ).toBe("<ul><b>5</b><b>7</b><b>9</b></ul>");
  });

  it("renders an unstepped range over an authored `mxIndex` (SSR)", () => {
    // The `from=`/`count=` form evaluates the bound outside the callback, so
    // this was always right; asserted so it stays that way.
    expect(
      renderSsr(
        `<for|i| from=mxIndex to=mxIndex+1><b>\${i}</b></for>`,
        "const mxIndex = 10;",
      ),
    ).toBe("<ul><b>10</b><b>11</b></ul>");
  });

  it("re-renders a stepped range when `from` changes (client)", () => {
    const snapshots = renderDom(
      `<for|i| from=base() to=base()+4 step=2><b>\${i}</b></for>`,
      "const [base, setBase] = createSignal(10);\nglobalThis.__setBase = setBase;",
      "__setBase",
      "20",
    );
    expect(snapshots).toEqual([
      "<ul><b>10</b><b>12</b><b>14</b></ul>",
      "<ul><b>20</b><b>22</b><b>24</b></ul>",
    ]);
  });

  it("grows and shrinks a stepped range when `to` changes (client)", () => {
    const fragment = "<for|i| from=0 to=end() step=2><b>${i}</b></for>";
    const setup =
      "const [end, setEnd] = createSignal(4);\nglobalThis.__setEnd = setEnd;";
    expect(renderDom(fragment, setup, "__setEnd", "9")).toEqual([
      "<ul><b>0</b><b>2</b><b>4</b></ul>",
      "<ul><b>0</b><b>2</b><b>4</b><b>6</b><b>8</b></ul>",
    ]);
    expect(renderDom(fragment, setup, "__setEnd", "1")).toEqual([
      "<ul><b>0</b><b>2</b><b>4</b></ul>",
      "<ul><b>0</b></ul>",
    ]);
  });

  it("re-renders a stepped range when `step` changes (client)", () => {
    const snapshots = renderDom(
      "<for|i| from=0 to=12 step=gap()><b>${i}</b></for>",
      "const [gap, setGap] = createSignal(4);\nglobalThis.__setGap = setGap;",
      "__setGap",
      "3",
    );
    expect(snapshots).toEqual([
      "<ul><b>0</b><b>4</b><b>8</b><b>12</b></ul>",
      "<ul><b>0</b><b>3</b><b>6</b><b>9</b><b>12</b></ul>",
    ]);
  });

  it("re-renders an exclusive (`until`) stepped range when its bound changes (client)", () => {
    const snapshots = renderDom(
      "<for|i| from=1 until=end() step=2><b>${i}</b></for>",
      "const [end, setEnd] = createSignal(5);\nglobalThis.__setEnd = setEnd;",
      "__setEnd",
      "9",
    );
    expect(snapshots).toEqual([
      "<ul><b>1</b><b>3</b></ul>",
      "<ul><b>1</b><b>3</b><b>5</b><b>7</b></ul>",
    ]);
  });

  it("re-renders an unstepped range when a signal bound changes (client)", () => {
    const snapshots = renderDom(
      `<for|i| from=base() to=base()+1><b>\${i}</b></for>`,
      "const [base, setBase] = createSignal(10);\nglobalThis.__setBase = setBase;",
      "__setBase",
      "20",
    );
    expect(snapshots).toEqual([
      "<ul><b>10</b><b>11</b></ul>",
      "<ul><b>20</b><b>21</b></ul>",
    ]);
  });
});

/**
 * Solid's generated names were a `$mx`-prefixed set — `$mxProps`, `$mxBody`,
 * `$mxValue`, `$mx_Define*`, `$mxChildren`, `$mxMerge` — which is *not* the
 * `__mx` set `checkReservedBindings` reserves, so authored code could legally
 * take them.
 *
 * Only one of those is reachable today, and it is a silent wrong answer: a
 * `<define>` hoisted to module scope mints `$mx_Define<Name>1` from a
 * `taken` set that only holds names this compile already minted, so an
 * authored module-scope `function $mx_DefineRow1()` in a `.solid.mx` file
 * produced *two* functions of that name and the hoisted one silently won.
 *
 * The whole-unit wrapper's `$mxProps`/`$mxBody`/`$mxValue` are renamed for the
 * same reason but have no reachable repro: a whole-unit `.solid.mx` cannot
 * declare an authored binding at all (`<const>` is rejected inside a JSX
 * expression, and a module-level `const` is read as one), so the wrapper
 * scope only ever contains generated names. That is a property of today's
 * rejections, not a guarantee, so the rename stands on its own.
 */
describe("Solid's generated bindings use the reserved `__mx` names", () => {
  const hoistedDefineNames = (source: string): string[] => {
    const file = parse(source, "probe.solid.mx", {
      mxRegionCompile: solidRegionCompile,
    }) as unknown as {
      program: { body: Array<{ type?: string; id?: { name?: string } }> };
    };
    return file.program.body
      .filter((node) => node.type === "FunctionDeclaration")
      .map((node) => node.id?.name ?? "");
  };

  it("does not mint a `<define>` binding over an authored module-scope function", () => {
    const names = hoistedDefineNames(
      [
        "function $mx_DefineRow1() { return 'authored'; }",
        "export function A() {",
        "  return (<div><define/Row>mine</define><Row/></div>);",
        "}",
      ].join("\n"),
    );
    // Two distinct functions, not a silent duplicate declaration.
    expect([...names].sort()).toEqual(["$mx_DefineRow1", "__mx_DefineRow1"]);
    expect(new Set(names).size).toBe(2);
  });

  it("names a hoisted `<define>` `__mx_Define*`", () => {
    const code = compileSolidMx("<define/Row>a</define><Row/>", {
      filename: "fixture.solid.mx",
    }).code;
    expect(code).toContain("__mx_DefineRow1");
    expect(code).not.toContain("$mx_Define");
  });

  it("names the whole-unit wrapper bindings `__mx*`", () => {
    const code = compileSolidUnit(
      [
        "export interface Input { title: string }",
        '<section class="panel">${input.title}${input.content()}</section>',
      ].join("\n"),
      { filename: "/fixtures/panel.mx" },
    ).code;
    expect(code).toContain("export default function Panel(__mxProps: Input)");
    expect(code).toContain("const __mxBody = __mxChildren(");
    expect(code).toContain("const __mxValue = __mxBody()");
    expect(code).not.toMatch(/\$mx(?:Props|Body|Value|Children|Merge)/);
  });
});
