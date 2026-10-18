// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `<${D}/>` where `D` is a `<define>` without attributes renders the define
 * (stock Marko 6.4.4: `<define/D><i>b</i></define><${D}/>` renders
 * `<i>b</i>`). Solid hoists a define to a module-level function under a
 * generated name, so the target used to be emitted as the author's `D`, a name
 * nothing declares at module scope. The target now reads the hoisted function,
 * which `<Dynamic>` renders.
 *
 * Probed on stock with `bun run --cwd packages/stock-marko probe`: all four
 * sources below compile there, except the define declared after the read
 * (a compile error: "Hoisted values must be functions. The `<define>` tag
 * variable may not be hoisted").
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import { sourceBindings } from "@mxlang/tsx-bridge";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

function compile(region: string, setup = "") {
  return compileSolidMx(region, {
    filename: "fixture.solid.mx",
    moduleBindings: sourceBindings(setup).bindings,
  });
}

/** The emitted text with the module-wide dynamic-tag serial taken out. */
function emit(region: string, setup = "") {
  const result = compile(region, setup);
  return {
    ...result,
    code: result.code.replace(/__mxDyn(Value)?\d+/g, "__mxDyn$1"),
  };
}

function render(region: string, setup = ""): string {
  const { code, hoistedImports, hoistedDefines } = compile(region, setup);
  const imports = [...hoistedImports, ...hoistedDefines]
    .map((entry) => entry.code)
    .join("\n");
  const source = `${imports}\n${setup}\nexport function App() {\n  return <ul>${code}</ul>;\n}\n`;
  const out = transformSync(source, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error("Solid babel plugin produced no code");
  const dir = mkdtempSync(join(packageRoot, ".define-dyn-tmp-"));
  try {
    writeFileSync(join(dir, "app.mjs"), out.code);
    writeFileSync(
      join(dir, "run.mjs"),
      `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
    );
    return execFileSync("bun", ["run", join(dir, "run.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 20_000,
    }).replace(/ _hk=\d+ ?/g, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DEFINE = "<define/D><i>b</i></define>";
const INPUT = (c: boolean) => `const input = { c: ${c} };`;

describe("solid: a dynamic tag reads a <define> without attributes", () => {
  it("emits the hoisted function, not the author's name", () => {
    const { code, hoistedDefines } = emit(`${DEFINE}<\${D}/>`);
    expect(hoistedDefines.map((entry) => entry.binding)).toEqual([
      "__mx_DefineD1",
    ]);
    expect(code).toContain("const __mxDyn = __mx_DefineD1;");
    expect(code).not.toMatch(/__mxDyn = D;/);
    expect(code).not.toContain("__mxDefineFn_");
  });

  it("renders the define", () => {
    expect(render(`${DEFINE}<\${D}/>`)).toBe("<ul><i>b</i></ul>");
  });

  it("with a body, renders the define and ignores the body, as Marko does", () => {
    const { code } = emit(`${DEFINE}<\${D}>x</>`);
    expect(code).toContain("const __mxDyn = __mx_DefineD1;");
    expect(render(`${DEFINE}<\${D}>x</>`)).toBe("<ul><i>b</i></ul>");
  });

  it("a conditional target reads the hoisted function in its branch", () => {
    const region = `${DEFINE}<\${input.c ? D : "span"}/>`;
    expect(emit(region, INPUT(true)).code).toContain(
      'const __mxDyn = input.c ? __mx_DefineD1 : "span";',
    );
    expect(render(region, INPUT(true))).toBe("<ul><i>b</i></ul>");
    expect(render(region, INPUT(false))).toBe("<ul><span></span></ul>");
  });

  it("a define with a param takes the call's attributes as its first argument", () => {
    const region = "<define/D|p|><b>${p.n}</b></define><${D} n=3/><${D} n=4/>";
    expect(render(region)).toBe("<ul><b>3</b><b>4</b></ul>");
  });

  it("a define in an element body reads from inside it", () => {
    expect(render("<div><define/D><i>b</i></define><${D}/></div>")).toBe(
      "<ul><div><i>b</i></div></ul>",
    );
  });

  it("two defines: each target reads its own function", () => {
    const region =
      "<define/A><i>a</i></define><define/B><b>b</b></define><${A}/><${B}/>";
    const { code } = emit(region);
    expect(code).toContain("const __mxDyn = __mx_DefineA1;");
    expect(code).toContain("const __mxDyn = __mx_DefineB1;");
    expect(render(region)).toBe("<ul><i>a</i><b>b</b></ul>");
  });

  it("a loop param named like the define shadows it", () => {
    const { code } = emit(`${DEFINE}<for|D| of=[1]><\${D}/></for>`);
    expect(code).not.toContain("__mx_DefineD1;");
    expect(code).toContain("const __mxDyn = D;");
  });

  it("a read that is not a dynamic tag's target is left as written", () => {
    const { code } = emit(`${DEFINE}<p>\${typeof D}</p><\${D}/>`);
    expect(code).toContain("typeof D");
    expect(code).not.toContain("__mxDefineFn_");
  });

  it("a name that is not a define is left alone", () => {
    const { code } = emit("<${input.D}/>");
    expect(code).toContain("const __mxDyn = input.D;");
  });

  it("a define declared after the read is unchanged: the name stays unbound", () => {
    const { code } = emit(`<\${D}/>${DEFINE}`);
    expect(code).toContain("const __mxDyn = D;");
  });
});
