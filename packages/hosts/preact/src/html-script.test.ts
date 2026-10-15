// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FunctionComponent, h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * `<html-script>` is the tag for a native html `<script>` element. Stock Marko
 * 6.4.4 writes a real `<script>` that keeps every attribute, with a body that
 * is script text: placeholders stringified as in any text, the whole body then
 * escaped for script context (`<script`, `</script`, `<!--` become `\u003C…`),
 * never HTML-escaped. This host used to emit a literal `<html-script>`
 * element. It now writes a `<script>` whose body rides
 * `dangerouslySetInnerHTML`, because every JSX renderer HTML-escapes a text
 * child (a `&&` in script source would reach the browser as `&amp;&amp;`).
 *
 * Rendered for real through `preact-render-to-string`, whole file.
 */

async function renderMx(
  source: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mx-preact-html-script-"));
  try {
    symlinkSync(
      dirname(dirname(require.resolve("preact/package.json"))),
      join(dir, "node_modules"),
      "dir",
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" },
      }),
    );
    const entry = join(dir, "App.tsx");
    writeFileSync(entry, compilePreactMx(source, join(dir, "App.mx")).code);
    const module = (await import(`${entry}?t=${Date.now()}`)) as {
      default: FunctionComponent<Record<string, unknown>>;
    };
    return render(h(module.default, input));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const code = (source: string) => compilePreactMx(source, "/x/App.mx").code;

describe("<html-script> on Preact emits a real <script>", () => {
  it.each([
    [
      "an element inside a string",
      '<html-script>x = "<b>hi</b>"; go();</html-script>',
    ],
    ["an <if>", "<html-script>x(); <if=input.c>y();</if></html-script>"],
    ["a comment", "<html-script>a(); <!-- c --> b();</html-script>"],
  ])(
    "refuses markup in the body instead of dropping it: %s",
    (_name, source) => {
      let error: unknown;
      try {
        compilePreactMx(source, "/x/App.mx");
      } catch (caught) {
        error = caught;
      }
      // Positioned at the offending child, not at the tag or 1:1.
      expect(error).toMatchObject({
        message: expect.stringMatching(/read as markup/),
        line: 1,
        column: 18,
      });
    },
  );
  it("writes a script element, not a literal <html-script>", () => {
    const emitted = code('<html-script async src="/a.js"/>');
    expect(emitted).toContain('<script async={true} src="/a.js" />');
    expect(emitted).not.toContain("html-script");
  });

  it("carries the body through the raw-HTML prop with the script escape", () => {
    const emitted = code("<html-script>const v = ${input.x};</html-script>");
    expect(emitted).toContain(
      'dangerouslySetInnerHTML={{ __html: __mxScriptText("const v = ", input.x, ";") }}',
    );
    expect(emitted).toContain("const __mxScriptText =");
  });

  it("emits no helper when no script has a body", () => {
    expect(code('<html-script src="/a.js"/>')).not.toContain("__mxScriptText");
  });

  it("refuses an explicit dangerouslySetInnerHTML, as it does on any native element", () => {
    expect(() =>
      code(
        "<html-script dangerouslySetInnerHTML={__html: 'x'}>y</html-script>",
      ),
    ).toThrow(
      "`dangerouslySetInnerHTML` is not a valid attribute, did you mean `$!{html}`?",
    );
  });
});

describe("<html-script> on Preact keeps its attributes", () => {
  it("static, dynamic and boolean attributes", async () => {
    expect(
      await renderMx(
        '<html-script type="module" data-x=input.y async>go();</html-script>',
        { y: "a b" },
      ),
    ).toBe('<script type="module" data-x="a b" async>go();</script>');
  });

  it("a self-closing script with src", async () => {
    expect(await renderMx('<html-script async src="/a.js"/>')).toBe(
      '<script async src="/a.js"></script>',
    );
  });

  it("a nonce the author gives is kept, none is invented", async () => {
    expect(
      await renderMx("<html-script nonce=input.n>go();</html-script>", {
        n: "k1",
      }),
    ).toBe('<script nonce="k1">go();</script>');
    expect(await renderMx("<html-script>go();</html-script>")).toBe(
      "<script>go();</script>",
    );
  });

  it("a spread contributes its attributes", async () => {
    expect(
      await renderMx("<html-script ...input.a>go();</html-script>", {
        a: { type: "module", "data-k": "v" },
      }),
    ).toBe('<script type="module" data-k="v">go();</script>');
  });

  it("a false attribute is dropped", async () => {
    expect(
      await renderMx("<html-script defer=input.f src=input.s/>", {
        f: false,
        s: "/a.js",
      }),
    ).toBe('<script src="/a.js"></script>');
  });
});

describe("<html-script> on Preact interpolates its body as script text", () => {
  it("a placeholder is stringified, not HTML-escaped", async () => {
    expect(
      await renderMx(
        "<html-script>if (a && b) { v = ${input.x}; }</html-script>",
        { x: `a<b&c"d'e>` },
      ),
    ).toBe(`<script>if (a && b) { v = a<b&c"d'e>; }</script>`);
  });

  it("a `</script>` in a placeholder cannot close the element", async () => {
    const html = await renderMx("<html-script>${input.s}</html-script>", {
      s: "</script>",
    });
    expect(html).toBe("<script>\\u003C/script></script>");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it.each([
    ["</SCRIPT>", "\\u003C/SCRIPT>"],
    ["<Script src=x>", "\\u003CScript src=x>"],
    ["<!--", "\\u003C!--"],
    ["a <!-- b </script> c", "a \\u003C!-- b \\u003C/script> c"],
    ["<b>&amp;</b>", "<b>&amp;</b>"],
  ])("a placeholder holding %j is written as %j", async (value, written) => {
    expect(
      await renderMx("<html-script>${input.v}</html-script>", { v: value }),
    ).toBe(`<script>${written}</script>`);
  });

  it("the static text of the body keeps its entities and markup characters", async () => {
    expect(
      await renderMx(
        "<html-script>if (a < b && c > d) go('&amp;');</html-script>",
      ),
    ).toBe("<script>if (a < b && c > d) go('&amp;');</script>");
  });

  it.each([
    ["false", false, ""],
    ["null", null, ""],
    ["the empty string", "", ""],
    ["NaN", Number.NaN, ""],
    ["0", 0, "0"],
    ["1", 1, "1"],
    ["true", true, "true"],
  ])(
    "%s prints as Marko's text placeholder does",
    async (_name, value, text) => {
      expect(
        await renderMx("<html-script>[${input.v}]</html-script>", { v: value }),
      ).toBe(`<script>[${text}]</script>`);
    },
  );
});
