// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX placeholder syntax in template source
/**
 * `<html-script>` writes a real `<script>` on React, keeps its attributes and
 * writes the body as script text (placeholders stringified, then escaped for
 * script context, never HTML-escaped), as stock Marko does. Rendered for real
 * through `react-dom/server`, whole-file. The Preact host owns the emitter; this pins
 * the React dialect over it.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

async function renderMx(
  source: string,
  props: Record<string, unknown> = {},
): Promise<string> {
  const { renderToStaticMarkup } = (await import("react-dom/server")) as {
    renderToStaticMarkup: (vnode: unknown) => string;
  };
  const { createElement } = await import("react");
  const scratch = mkdtempSync(join(tmpdir(), "mx-react-html-script-"));
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
    const entry = join(scratch, "caller.tsx");
    writeFileSync(
      entry,
      compileReactMx(source, join(scratch, "caller.mx")).code,
    );
    const mod = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => unknown;
    };
    return renderToStaticMarkup(createElement(mod.default as never, props));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("<html-script> on React", () => {
  it("emits a real <script>, never a literal <html-script>", () => {
    const code = compileReactMx(
      '<html-script type="module">go();</html-script>',
      "/x/a.mx",
    ).code;
    expect(code).toContain("<script");
    expect(code).not.toContain("html-script");
    expect(code).toContain("dangerouslySetInnerHTML");
  });

  it("keeps static, dynamic and spread attributes", async () => {
    expect(
      await renderMx(
        '<html-script type="module" data-x=input.y ...input.a>go();</html-script>',
        { y: "a b", a: { "data-k": "v" } },
      ),
    ).toBe('<script type="module" data-x="a b" data-k="v">go();</script>');
  });

  it("keeps an author's nonce and invents none", async () => {
    expect(
      await renderMx("<html-script nonce=input.n>go();</html-script>", {
        n: "k1",
      }),
    ).toBe('<script nonce="k1">go();</script>');
    expect(await renderMx("<html-script>go();</html-script>")).toBe(
      "<script>go();</script>",
    );
  });

  it("does not HTML-escape the body", async () => {
    expect(
      await renderMx(
        "<html-script>if (a && b) { v = ${input.x}; }</html-script>",
        { x: `a<b&c"d'e>` },
      ),
    ).toBe(`<script>if (a && b) { v = a<b&c"d'e>; }</script>`);
  });

  it("a `</script>` in a placeholder cannot close the element", async () => {
    const html = await renderMx("<html-script>${input.s}</html-script>", {
      s: "</SCRIPT> <!-- <script>",
    });
    expect(html).toBe(
      "<script>\\u003C/SCRIPT> \\u003C!-- \\u003Cscript></script>",
    );
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
  });

  it.each([
    [false, ""],
    [null, ""],
    [0, "0"],
    [true, "true"],
  ])("a placeholder of %j prints as Marko's text does", async (v, text) => {
    expect(
      await renderMx("<html-script>[${input.v}]</html-script>", { v }),
    ).toBe(`<script>[${text}]</script>`);
  });
});
