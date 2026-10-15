// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FunctionComponent, h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * Stock Marko 6.4.4 prints a spread's `dangerouslySetInnerHTML`, `innerHTML`
 * and `outerHTML` keys as ordinary attributes with an escaped value (probed:
 * `_attrs` writes `innerHTML="<b>x</b>"`, and an object value as
 * `[object Object]`), and refuses a literal `dangerouslySetInnerHTML=` on a
 * native element ("is not a valid attribute, did you mean `$!{html}`?").
 *
 * This host's JSX renderers read those keys as raw HTML, so a spread object
 * carrying one (from `input`, say) injected markup into any element. The
 * spread helper now validates them like every other attribute and writes them
 * under their lowercase name, which is no such prop: every renderer then
 * writes the plain attribute Marko does, and an HTML parser reads the same
 * attribute name. Rendered for real through `preact-render-to-string`.
 */

async function renderMx(
  source: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mx-preact-raw-html-spread-"));
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

function failure(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compilePreactMx(source, "/x/App.mx");
  } catch (error) {
    return error as { message: string; line: number; column: number };
  }
  throw new Error("expected a compile error, but the template compiled");
}

const RAW = "<b>x</b>";

describe("a spread key that names raw HTML is an escaped attribute", () => {
  it.each([
    ["dangerouslySetInnerHTML", "dangerouslysetinnerhtml"],
    ["innerHTML", "innerhtml"],
    ["outerHTML", "outerhtml"],
  ])("%s", async (key, written) => {
    const html = await renderMx("<div ...input.attrs/>", {
      attrs: { [key]: RAW },
    });
    expect(html).not.toContain(RAW);
    expect(html).toMatch(new RegExp(`^<div ${written}="&lt;b[^"]*"></div>$`));
  });

  it("keeps the element's body and its other attributes", async () => {
    const html = await renderMx("<div ...input.attrs>body</div>", {
      attrs: { dangerouslySetInnerHTML: RAW, id: "a" },
    });
    expect(html).toMatch(
      /^<div id="a" dangerouslysetinnerhtml="[^"]*">body<\/div>$/,
    );
    expect(html).not.toContain(RAW);
  });

  it("applies to a merged object: attributes before and after the spread", async () => {
    const html = await renderMx('<div class="c" ...input.attrs title="t"/>', {
      attrs: { innerHTML: RAW },
    });
    expect(html).not.toContain(RAW);
    expect(html).toContain('class="c"');
    expect(html).toContain('title="t"');
    expect(html).toContain("innerhtml=");
  });

  it("applies to a dynamic tag that resolves to an element", async () => {
    for (const key of ["dangerouslySetInnerHTML", "innerHTML"]) {
      const html = await renderMx("<${input.tag} ...input.attrs/>", {
        tag: "p",
        attrs: { [key]: RAW },
      });
      expect(html).not.toContain(RAW);
      expect(html).toMatch(/^<p [a-z]+="&lt;b/);
    }
  });

  it("drops a null, undefined or false value, as it does any attribute", async () => {
    for (const value of [null, undefined, false]) {
      expect(
        await renderMx("<div ...input.attrs/>", {
          attrs: { dangerouslySetInnerHTML: value, innerHTML: value },
        }),
      ).toBe("<div></div>");
    }
  });

  it("an object value throws, as the attribute check does for any object", async () => {
    // Marko prints `[object Object]`; every MX host refuses that instead.
    await expect(
      renderMx("<div ...input.attrs/>", {
        attrs: { dangerouslySetInnerHTML: { __html: RAW } },
      }),
    ).rejects.toThrow(
      "The `dangerouslySetInnerHTML` attribute cannot be a plain object (it would render as `[object Object]`).",
    );
  });

  it("a later spread that overwrites the key hides it", async () => {
    expect(
      await renderMx("<div ...input.a ...input.b/>", {
        a: { innerHTML: RAW },
        b: { innerHTML: "plain" },
      }),
    ).toBe('<div innerhtml="plain"></div>');
  });

  it("leaves a component target's props alone", async () => {
    const Box = (props: { dangerouslySetInnerHTML?: { __html: string } }) =>
      h("i", { dangerouslySetInnerHTML: props.dangerouslySetInnerHTML });
    expect(
      await renderMx("<${input.C} ...input.attrs/>", {
        C: Box,
        attrs: { dangerouslySetInnerHTML: { __html: "<u>ok</u>" } },
      }),
    ).toBe("<i><u>ok</u></i>");
  });
});

describe("what writes raw HTML on purpose still does", () => {
  it("`$!{…}` as the sole child", async () => {
    expect(await renderMx("<div>$!{input.h}</div>", { h: "<b>raw</b>" })).toBe(
      "<div><b>raw</b></div>",
    );
  });

  it("`<html-script>` keeps its body as script text beside a spread", async () => {
    const html = await renderMx(
      "<html-script ...input.attrs>var a = 1 && 2;</html-script>",
      { attrs: { dangerouslySetInnerHTML: "<b>x</b>", innerHTML: "<i>y</i>" } },
    );
    expect(html).toContain(">var a = 1 && 2;</script>");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
  });
});

describe("a literal dangerouslySetInnerHTML= on a native element is refused, as Marko does", () => {
  const message =
    "`dangerouslySetInnerHTML` is not a valid attribute, did you mean `$!{html}`?";

  it.each([
    ["a dynamic value", "<div dangerouslySetInnerHTML=input.x/>", 1, 5],
    ["a string value", '<div dangerouslySetInnerHTML="a"/>', 1, 5],
    ["no value", "<div dangerouslySetInnerHTML/>", 1, 5],
    ["an object literal", "<div dangerouslySetInnerHTML={__html: 'x'}/>", 1, 5],
    [
      "beside a raw child",
      "<div dangerouslySetInnerHTML=input.x>$!{input.h}</div>",
      1,
      5,
    ],
    [
      "<html-script> with a body",
      "<html-script dangerouslySetInnerHTML=input.x>y</html-script>",
      1,
      13,
    ],
    [
      "<html-script> without a body",
      "<html-script dangerouslySetInnerHTML=input.x/>",
      1,
      13,
    ],
    [
      "a later line",
      '<section>\n  <div class="a"\n    dangerouslySetInnerHTML=input.x/>\n</section>',
      3,
      4,
    ],
  ])("%s", (_name, source, line, column) => {
    expect(failure(source)).toMatchObject({ message, line, column });
  });

  it("is not refused on a component", () => {
    expect(
      compilePreactMx(
        "<${input.C} dangerouslySetInnerHTML=input.x/>",
        "/x/App.mx",
      ).code,
    ).toContain("dangerouslySetInnerHTML");
  });
});
