// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `<Row n=1/>` on a `<define>` hands the attribute object to the define's
 * first param, as Marko does. It used to emit `Row(undefined)`, which compiled
 * clean and crashed at render (`p.n` of undefined).
 */
import { createElement, type FC } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

// Expected HTML is what stock Marko 6.3.51 renders for the same templates
// (probe: scratch/reports/squad-jsx/define-call-attrs.md).
const CASES: Array<[string, string, string]> = [
  [
    "|p| reads the attribute object",
    "<define/Row|p|><li>${p.n}</li></define>\n<ul><Row n=1/></ul>",
    "<ul><li>1</li></ul>",
  ],
  [
    "|{ n }| destructures the attribute object",
    "<define/Row|{ n }|><li>${n}</li></define>\n<ul><Row n=2/></ul>",
    "<ul><li>2</li></ul>",
  ],
  [
    "a call with no attributes passes {} (not undefined)",
    "<define/Row|p|><li>${Object.keys(p).length}</li></define>\n<ul><Row/></ul>",
    "<ul><li>0</li></ul>",
  ],
  [
    "a spread merges in source order, the later key wins",
    "<define/Row|p|><li>${p.x}${p.a}</li></define>\n<ul><Row x=0 ...{ a: 1, x: 2 }/></ul>",
    "<ul><li>21</li></ul>",
  ],
  [
    "a body arrives as content",
    "<define/Row|{ n, content }|><li>${n}<${content}/></li></define>\n<ul><Row n=1>text</Row></ul>",
    "<ul><li>1text</li></ul>",
  ],
  [
    "an attribute tag arrives under its name",
    "<define/Row|{ item }|><li><${item}/></li></define>\n<ul><Row><@item>x</@item></Row></ul>",
    "<ul><li>x</li></ul>",
  ],
  [
    "a define with no params ignores the attributes",
    "<define/Row><li>x</li></define>\n<ul><Row n=1/></ul>",
    "<ul><li>x</li></ul>",
  ],
  [
    "tag arguments still bind positionally",
    "<define/Row|a|><li>${a}</li></define>\n<ul><Row(1)/></ul>",
    "<ul><li>1</li></ul>",
  ],
];

async function renderWhole(source: string): Promise<string> {
  const { writeFileSync, mkdtempSync, rmSync, symlinkSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const scratch = mkdtempSync(join(tmpdir(), "mx-react-define-attrs-"));
  try {
    symlinkSync(
      dirname(dirname(require.resolve("react/package.json"))),
      join(scratch, "node_modules"),
      "dir",
    );
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
      }),
    );
    const entry = join(scratch, "page.tsx");
    writeFileSync(entry, compileReactMx(source, join(scratch, "page.mx")).code);
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FC<Record<string, unknown>>;
    };
    return renderToStaticMarkup(createElement(mod.default, {}));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("react: a <define> call passes its attributes as the first param", () => {
  it.each(CASES)("%s", async (_name, source, html) => {
    expect(await renderWhole(source)).toBe(html);
  });

  it("emits the attribute object, never undefined, for the call", () => {
    const code = compileReactMx(
      "<define/Row|p|><li>${p.n}</li></define>\n<ul><Row n=1/></ul>",
      "/fixtures/row.mx",
    ).code;
    expect(code).toContain('{Row({ "n": 1 })}');
    expect(code).not.toContain("Row(undefined)");
  });
});
