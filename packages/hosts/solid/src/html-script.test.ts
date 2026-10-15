// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

/**
 * `<html-script>` is the tag for a native html `<script>` element. Stock Marko
 * 6.4.4 writes a real `<script>` that keeps every attribute, with a body that
 * is script text: placeholders stringified as in any text, the whole body then
 * escaped for script context (`<script`, `</script`, `<!--` become `\u003C…`),
 * never HTML-escaped. Solid used to emit a literal `<html-script>` element.
 * It now writes a `<script>` whose body rides `innerHTML`, because Solid's
 * renderer HTML-escapes a text child (`&&` would reach the browser as
 * `&amp;&amp;`).
 *
 * Rendered through the real pipeline: `compileSolidMx` -> `@solidjs/babel-plugin`
 * SSR codegen -> `@solidjs/web`'s `renderToString`, in a Bun subprocess (see
 * `ssr-render.test.ts` for why not in-process).
 */

const packageRoot = new URL("..", import.meta.url).pathname;

function emitted(source: string) {
  return compileSolidMx(source, { filename: "fixture.solid.mx" });
}

function render(source: string, input: Record<string, unknown> = {}): string {
  const { code, hoistedImports, hoistedDefines } = emitted(source);
  const imports = [...hoistedImports, ...hoistedDefines]
    .map((entry) => entry.code)
    .join("\n");
  const jsx = `${imports}\nexport function App() {\n  const input: any = ${JSON.stringify(input)};\n  return <>${code}</>;\n}\n`;
  const out = transformSync(jsx, {
    filename: "fixture.tsx",
    presets: [[typescriptPreset, {}]],
    plugins: [[solidBabelPlugin, { generate: "ssr", hydratable: false }]],
    babelrc: false,
    configFile: false,
  });
  if (!out?.code) throw new Error("Solid emitted no fixture code");
  const dir = mkdtempSync(join(packageRoot, ".html-script-tmp-"));
  try {
    writeFileSync(join(dir, "app.mjs"), out.code);
    const runner = join(dir, "run.mjs");
    writeFileSync(
      runner,
      `import { renderToString } from "@solidjs/web";\nimport { App } from "./app.mjs";\nprocess.stdout.write(renderToString(() => App()));\n`,
    );
    return execFileSync("bun", ["run", runner], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 20_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("<html-script> on Solid emits a real <script>", () => {
  it("writes a script element, not a literal <html-script>", () => {
    const { code } = emitted('<html-script async src="/a.js"/>');
    expect(code).toContain("<script");
    expect(code).not.toContain("html-script");
  });

  it("carries the body through innerHTML with the script escape", () => {
    const { code, hoistedDefines } = emitted(
      "<html-script>const v = ${input.x};</html-script>",
    );
    expect(code).toContain(
      '<script innerHTML={__mxScriptText("const v = ", input.x, ";")} />',
    );
    expect(hoistedDefines.map((define) => define.binding)).toContain(
      "__mxScriptText",
    );
  });

  it("emits no helper when no script has a body", () => {
    const { code, hoistedDefines } = emitted('<html-script src="/a.js"/>');
    expect(code).not.toContain("__mxScriptText");
    expect(hoistedDefines).toEqual([]);
  });

  it("a whole-file unit declares the helper beside the component", () => {
    const { code } = compileSolidUnit(
      '<html-script type="module">go(${input.x});</html-script>',
      { filename: "/x/App.mx" },
    );
    expect(code).toContain("function __mxScriptText(");
    expect(code).toContain(
      '<script type="module" innerHTML={__mxScriptText("go(", input.x, ");")} />',
    );
  });

  it("refuses a body beside an explicit innerHTML", () => {
    expect(() =>
      emitted("<html-script innerHTML=input.h>y</html-script>"),
    ).toThrow(/innerHTML/);
  });
});

describe("<html-script> on Solid keeps its attributes and escapes its body as script text", () => {
  it("static, dynamic and boolean attributes", () => {
    expect(
      render(
        '<html-script type="module" data-x=input.y async>go();</html-script>',
        { y: "a b" },
      ),
    ).toBe('<script type="module" data-x="a b" async>go();</script>');
  });

  it("a self-closing script with src", () => {
    expect(render('<html-script async src="/a.js"/>')).toBe(
      '<script async src="/a.js"></script>',
    );
  });

  it("an author's nonce is kept and none is invented", () => {
    expect(
      render("<html-script nonce=input.n>go();</html-script>", { n: "k1" }),
    ).toBe('<script nonce="k1">go();</script>');
    expect(render("<html-script>go();</html-script>")).toBe(
      "<script>go();</script>",
    );
  });

  it("a placeholder is stringified, not HTML-escaped", () => {
    expect(
      render("<html-script>if (a && b) { v = ${input.x}; }</html-script>", {
        x: `a<b&c"d'e>`,
      }),
    ).toBe(`<script>if (a && b) { v = a<b&c"d'e>; }</script>`);
  });

  it("a `</script>` in a placeholder cannot close the element", () => {
    const html = render("<html-script>${input.s}</html-script>", {
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
  ])("a placeholder of %j prints as Marko's text does", (v, text) => {
    expect(render("<html-script>[${input.v}]</html-script>", { v })).toBe(
      `<script>[${text}]</script>`,
    );
  });

  it("static text keeps its entities and markup characters", () => {
    expect(
      render("<html-script>if (a < b && c > d) go('&amp;');</html-script>"),
    ).toBe("<script>if (a < b && c > d) go('&amp;');</script>");
  });

  it("keeps a body beside a spread whose innerHTML is not the body", () => {
    const html = render(
      "<html-script ...input.a>var a = 1 && 2;</html-script>",
      {
        a: { innerHTML: "<b>x</b>", id: "s" },
      },
    );
    expect(html).toContain("var a = 1 && 2;");
    expect(html).not.toContain("<b>x</b></script>");
    expect(html).not.toMatch(/<script[^>]*>[^<]*<b>/);
  });
});
