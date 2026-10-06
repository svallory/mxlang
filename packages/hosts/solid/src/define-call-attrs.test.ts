// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * Decision 160 on Solid: `<Row n=1/>` against a `<define>` hands the define's
 * first param ONE attribute object, as Marko 6.3.51 does. It used to emit
 * `__mx_DefineRow1(undefined)`, and `|{ n }|` failed compile ("cannot close
 * over `n`"). Every case here EXECUTES the output (Solid SSR in a Bun
 * subprocess), because the old defect compiled clean and crashed at render.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import { sourceBindings, unknownSourceBindings } from "@mxlang/tsx-bridge";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

const packageRoot = new URL("..", import.meta.url).pathname;

/** `setup` is module-level text, so a define can read it as a module binding. */
function compile(
  region: string,
  setup: string,
  warnings?: Array<{ message: string; line: number; column: number }>,
) {
  return compileSolidMx(region, {
    filename: "fixture.solid.mx",
    moduleBindings: sourceBindings(setup).bindings,
    unknownModuleBindings: unknownSourceBindings(setup),
    ...(warnings ? { warnings } : {}),
  });
}

function render(region: string, setup = ""): string {
  const { code, hoistedImports, hoistedDefines } = compile(region, setup);
  const imports = [...hoistedImports, ...hoistedDefines]
    .map((entry) => entry.code)
    .join("\n");
  const jsxSource = `${imports}\n${setup}\nexport function App() {\n  return <ul>${code}</ul>;\n}\n`;
  const ssr = transformSync(jsxSource, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!ssr?.code) throw new Error("Solid babel plugin produced no code");
  const dir = mkdtempSync(join(packageRoot, ".define-attrs-tmp-"));
  try {
    writeFileSync(join(dir, "app.mjs"), ssr.code);
    writeFileSync(
      join(dir, "run.mjs"),
      `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
    );
    return execFileSync("bun", ["run", join(dir, "run.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Expected HTML is what stock Marko 6.3.51 renders for the same templates
// (the same cases as preact's `define-call-attrs.test.ts`).
const CASES: Array<[string, string, string, string]> = [
  [
    "|p| reads the attribute object",
    "<define/Row|p|><li>${p.n}</li></define><Row n=1/>",
    "",
    "<ul><li>1</li></ul>",
  ],
  [
    "|{ n }| destructures the attribute object",
    "<define/Row|{ n }|><li>${n}</li></define><Row n=2/>",
    "",
    "<ul><li>2</li></ul>",
  ],
  [
    "|{ n }, i| destructures the first param; the second stays undefined",
    "<define/Row|{ n }, i|><li>${n}-${i === undefined ? 'u' : i}</li></define><Row n=3/>",
    "",
    "<ul><li>3-u</li></ul>",
  ],
  [
    "a call with no attributes passes {} (not undefined)",
    "<define/Row|p|><li>${Object.keys(p).length}</li></define><Row/>",
    "",
    "<ul><li>0</li></ul>",
  ],
  [
    "a spread merges in source order, the later key wins",
    "<define/Row|p|><li>${p.x}${p.a}</li></define><Row x=0 ...{ a: 1, x: 2 }/>",
    "",
    "<ul><li>21</li></ul>",
  ],
  [
    "a body arrives as content",
    "<define/Row|{ n, content }|><li>${n}${content}</li></define><Row n=1>text</Row>",
    "",
    "<ul><li>1text</li></ul>",
  ],
  [
    "an attribute tag arrives under its name",
    "<define/Row|{ item }|><li><${item}/></li></define><Row><@item>x</@item></Row>",
    "",
    "<ul><li>x</li></ul>",
  ],
  [
    "a define with no params ignores the attributes",
    "<define/Row><li>x</li></define><Row n=1/>",
    "",
    "<ul><li>x</li></ul>",
  ],
  [
    "tag arguments still bind positionally",
    "<define/Row|a, b|><li>${a}${b}</li></define><Row(1, 2)/>",
    "",
    "<ul><li>12</li></ul>",
  ],
  [
    "tag arguments still fill the remaining params from an attribute tag",
    "<define/Row|a, b|><li>${a}${b}</li></define><Row(1)><@b>2</@b></Row>",
    "",
    "<ul><li>12</li></ul>",
  ],
  [
    "a destructuring default applies to a missing attribute",
    "<define/Row|{ n = 9 }|><li>${n}</li></define><Row/>",
    "",
    "<ul><li>9</li></ul>",
  ],
];

describe("solid: a <define> call passes its attributes as the first param", () => {
  it.each(CASES)(
    "%s",
    (_name, region, setup, html) => {
      expect(render(region, setup)).toBe(html);
    },
    30_000,
  );

  it("emits the attribute object, never undefined, for the call", () => {
    const { code } = compile(
      "<define/Row|p|><li>${p.n}</li></define><Row n=1/>",
      "",
    );
    expect(code).toContain('{ "n": 1 }');
    expect(code).not.toContain("(undefined)");
  });

  it("pads the params beyond the first with undefined, for the type checker", () => {
    const { code, hoistedDefines } = compile(
      "<define/Row|{ n }, i|><li>${n}</li></define><Row n=1/>",
      "",
    );
    expect(code).toContain(
      `{${hoistedDefines[0]?.binding}({ "n": 1 }, undefined)}`,
    );
  });

  it("emits no argument for a define without params", () => {
    const { code, hoistedDefines } = compile(
      "<define/Row>x</define><Row n=1/>",
      "",
    );
    expect(code).toContain(`{${hoistedDefines[0]?.binding}()}`);
  });

  it("still rejects a real capture of an outer template binding", () => {
    // `missing` is neither a param (destructured or not), a module binding,
    // another define nor a global: the capture check must still fire now
    // that destructured names are bound.
    expect(() =>
      compile(
        "<define/Row|{ n }|><li>${n}${missing}</li></define><Row n=1/>",
        "",
      ),
    ).toThrow(/cannot close over `missing`/);
  });

  // Pre-existing limit, unchanged by decision 160: the capture check does not
  // consult the module's own bindings (the spec says imports are fine; only a
  // define's params, sibling defines and globals pass today). Pinned so a
  // change to it is deliberate; reported to the lead as a separate item.
  it("reports a module binding read in a define body as a capture", () => {
    expect(() =>
      compile(
        "<define/Row|{ n }|><li>${n}${outer}</li></define><Row n=1/>",
        "const outer = 5;",
      ),
    ).toThrow(/cannot close over `outer`/);
  });

  it("warns on a multi-param define called with attributes, not for one object param", () => {
    const warn = (region: string) => {
      const warnings: Array<{ message: string; line: number; column: number }> =
        [];
      compile(region, "", warnings);
      return warnings;
    };
    expect(
      warn(
        '<define/Card|title, head|><div>${title}</div></define>\n<Card title="a"/>',
      ),
    ).toMatchObject([
      { line: 2, column: 1, message: expect.stringContaining("2 params") },
    ]);
    expect(
      warn(
        '<define/Card|{ title, head }|><div>${title}</div></define>\n<Card title="a"/>',
      ),
    ).toEqual([]);
  });
});
