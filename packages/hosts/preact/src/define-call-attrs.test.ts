// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `<Row n=1/>` on a `<define>` hands the attribute object to the define's
 * first param, as Marko does. It used to emit `Row(undefined)`, which compiled
 * clean and crashed at render (`p.n` of undefined).
 */
import { type FunctionComponent, h } from "preact";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

// Expected HTML is what stock Marko 6.4.4 renders for the same templates
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
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-define-attrs-"));
  try {
    symlinkSync(
      dirname(dirname(require.resolve("preact/package.json"))),
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
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
      }),
    );
    const entry = join(scratch, "page.tsx");
    writeFileSync(
      entry,
      compilePreactMx(source, join(scratch, "page.mx")).code,
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FunctionComponent<Record<string, unknown>>;
    };
    const { render } = (await import("preact-render-to-string")) as {
      render: (vnode: unknown) => string;
    };
    return render(h(mod.default, {}));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("preact: a <define> call passes its attributes as the first param", () => {
  it.each(CASES)("%s", async (_name, source, html) => {
    expect(await renderWhole(source)).toBe(html);
  });

  it("emits the attribute object, never undefined, for the call", () => {
    const code = compilePreactMx(
      "<define/Row|p|><li>${p.n}</li></define>\n<ul><Row n=1/></ul>",
      "/fixtures/row.mx",
    ).code;
    expect(code).toContain('{__mxDef_Row({ "n": 1 })}');
    expect(code).not.toContain("Row(undefined)");
  });

  it("warns on a multi-param define called with attributes, and not for one object param", () => {
    const warn = (source: string) => {
      const warnings: Array<{ message: string; line: number; column: number }> =
        [];
      compilePreactMx(source, "/fixtures/card.mx", { warnings });
      return warnings;
    };
    expect(
      warn(
        '<define/Card|title, head|><div>${title}</div></define>\n<Card title="a"/>',
      ),
    ).toMatchObject([{ line: 2, column: 1 }]);
    expect(
      warn(
        '<define/Card|{ title, head }|><div>${title}</div></define>\n<Card title="a"/>',
      ),
    ).toEqual([]);
  });
});

describe("preact: a <define> that declares <return>", () => {
  // Expected HTML is stock Marko 6.4.4's render, its resume comments removed.
  it.each([
    [
      "binds the returned value to the call's /var",
      "<define/Thing|input|>\n  <return=input.n * 2/>\n  <i>${input.n}</i>\n</define>\n<Thing/double n=21/>\n<p>${double}</p>\n",
      "<i>21</i><p>42</p>",
    ],
    [
      "renders only the output for a call without /var",
      "<define/T|{n}|><return=n/><b>${n}</b></define><T n=1/>",
      "<b>1</b>",
    ],
  ])("%s", async (_what, source, html) => {
    expect(await renderWhole(source)).toBe(html);
  });

  // Lead choice 3 (mx-nh8x, mx-bk8r): a call tag's `/T` inside an `<if>`
  // branch is scoped to that branch by core, so `<T/x/>` after it stays a
  // `define` call, while this host hoists the branch's statements and sees
  // `T` as local; emitting the define's pair function there would bind the
  // wrong value, so the refusal must still fire.
  it("refuses /var on a define call a call tag's /T hoisted out of an <if> shadows", () => {
    const source =
      "<define/T|{n}|><return=n/></define><define/Make><return=(() => 1)/></define><define/W><if=true><Make/T/></if><T/x n=1/><p>${x}</p></define><W/>";
    expect(() => compilePreactMx(source, "/fixtures/page.mx")).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(
          "a local binding of the same name shadows the `<define>`",
        ),
        line: 1,
        column: 109,
      }),
    );
  });

  // mx-nh8x: stock renders the loop value `U`, not the outer define `T`.
  it("renders a loop variable of a define's name as that value", async () => {
    expect(
      await renderWhole(
        "<define/T|{n}|><b>${n}</b></define><define/U|{n}|><i>${n}</i></define><for|T| of=[U]><T n=1/></for>",
      ),
    ).toBe("<i>1</i>");
  });

  // Stock renders `1020`: the `/var` binds in each row's own scope.
  it("binds a /var under <for> in each row's own scope", async () => {
    expect(
      await renderWhole(
        "<define/T|{n}|><return=n * 10/></define><for|i| of=[1, 2]><T/v n=i/>${v}</for>",
      ),
    ).toBe("1020");
  });
});
