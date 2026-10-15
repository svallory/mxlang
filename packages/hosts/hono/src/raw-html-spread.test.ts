// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { jsx } from "hono/jsx";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

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
 * attribute name. Rendered for real through `hono/jsx/dom/server`.
 */

async function renderMx(
  source: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  const { renderToString } = await import("hono/jsx/dom/server");
  const { jsx } = await import("hono/jsx");
  const dir = mkdtempSync(join(tmpdir(), "mx-hono-raw-html-spread-"));
  try {
    // Hono's exports table blocks `hono/package.json`, so resolve a real
    // subpath and walk up to the workspace `node_modules`.
    let nodeModules = dirname(require.resolve("hono/jsx"));
    while (!nodeModules.endsWith("node_modules")) {
      nodeModules = dirname(nodeModules);
    }
    symlinkSync(nodeModules, join(dir, "node_modules"), "dir");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono" },
      }),
    );
    const entry = join(dir, "App.tsx");
    writeFileSync(entry, compileHonoMx(source, join(dir, "App.mx")).code);
    const module = (await import(`${entry}?t=${Date.now()}`)) as {
      default: (props: Record<string, unknown>) => unknown;
    };
    return String(renderToString(jsx(module.default as never, input)));
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
    compileHonoMx(source, "/x/App.mx");
  } catch (error) {
    return error as { message: string; line: number; column: number };
  }
  throw new Error("expected a compile error, but the template compiled");
}

const RAW = "<b>x</b>";
const NODE = jsx("i", {}, "node");

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
      jsx("i", { dangerouslySetInnerHTML: props.dangerouslySetInnerHTML });
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
      compileHonoMx(
        "<${input.C} dangerouslySetInnerHTML=input.x/>",
        "/x/App.mx",
      ).code,
    ).toContain("dangerouslySetInnerHTML");
  });
});

describe("a literal innerHTML= or outerHTML= is an escaped lowercase attribute", () => {
  it.each([
    ["innerHTML on an element", "<div innerHTML=input.h/>", "innerhtml"],
    ["outerHTML on an element", "<div outerHTML=input.h/>", "outerhtml"],
    [
      "innerHTML on a custom element",
      "<my-el innerHTML=input.h/>",
      "innerhtml",
    ],
    [
      "outerHTML on a custom element",
      "<my-el outerHTML=input.h/>",
      "outerhtml",
    ],
    [
      "innerHTML beside a body",
      "<div innerHTML=input.h>kept</div>",
      "innerhtml",
    ],
    [
      "innerHTML on a dynamic tag",
      "<${input.tag} innerHTML=input.h/>",
      "innerhtml",
    ],
  ])("%s", async (_name, source, attribute) => {
    const html = await renderMx(source, { h: RAW, tag: "section" });
    expect(html).toContain(`${attribute}="`);
    // The value is escaped: no markup survives outside the attribute.
    expect(html.replace(/="[^"]*"/g, "")).not.toContain("<b>");
  });

  it("a string literal value is the same attribute", async () => {
    expect(await renderMx('<div innerHTML="a<b>c"/>')).toMatch(
      /^<div innerhtml="a&lt;b(&gt;|>)c"><\/div>$/,
    );
  });

  it("drops a null or false value, as any attribute", async () => {
    expect(await renderMx("<div innerHTML=input.h/>", { h: false })).toBe(
      "<div></div>",
    );
  });

  it("is not renamed on a component", async () => {
    const Box = (props: { innerHTML?: string }) =>
      jsx("i", {}, props.innerHTML ?? "");
    expect(
      await renderMx("<${input.C} innerHTML=input.h/>", { C: Box, h: "t" }),
    ).toBe("<i>t</i>");
  });
});

describe("a spread's object value says how to write raw HTML", () => {
  it.each(["dangerouslySetInnerHTML", "innerHTML", "outerHTML"])(
    "%s",
    async (key) => {
      await expect(
        renderMx("<div ...input.attrs/>", {
          attrs: { [key]: { __html: RAW } },
        }),
      ).rejects.toThrow(
        "To write raw HTML, make `$!{html}` the element's only child.",
      );
    },
  );
});

describe("a plain object in a text interpolation prints as Marko prints it", () => {
  const DATA = { tag: "img", type: "img", props: { onerror: "x" }, t: RAW };

  it("stringifies JSON-shaped data, escaped", async () => {
    expect(await renderMx("<p>${input.x}</p>", { x: DATA })).toBe(
      "<p>[object Object]</p>",
    );
  });

  it("honours the object's own toString, escaped", async () => {
    const html = await renderMx("<p>${input.x}</p>", {
      x: { toString: () => RAW },
    });
    expect(html).toMatch(/^<p>&lt;b(&gt;|>)x&lt;\/b(&gt;|>)<\/p>$/);
  });

  it("stringifies a null-prototype object", async () => {
    const x = Object.assign(Object.create(null), { a: 1 });
    expect(await renderMx("<p>${input.x}</p>", { x })).toBe(
      "<p>[object Object]</p>",
    );
  });

  it("maps an array that holds an object", async () => {
    expect(await renderMx("<p>${input.x}</p>", { x: ["a", DATA] })).toBe(
      "<p>a[object Object]</p>",
    );
  });

  it("leaves primitives and a renderer-made node alone", async () => {
    expect(
      await renderMx("<p>${input.a}|${input.b}|${input.c}|${input.d}</p>", {
        a: "s",
        b: 0,
        c: null,
        d: undefined,
      }),
    ).toBe("<p>s|0||</p>");
    expect(await renderMx("<p>${input.x}</p>", { x: NODE })).toBe(
      "<p><i>node</i></p>",
    );
    expect(await renderMx("<p>${input.x}</p>", { x: [NODE, "!"] })).toBe(
      "<p><i>node</i>!</p>",
    );
  });
});

describe("the text-placeholder guard in the emitted module", () => {
  it("wraps a placeholder that may hold an object, and nothing else", () => {
    const { code } = compileHonoMx(
      '<p>${input.x}|${"s"}|${1}|${`t`}|${null}</p>',
      "/x/App.mx",
    );
    expect(code).toContain("{__mxTextValue(input.x)}");
    expect(code.match(/__mxTextValue\(/g)).toHaveLength(1);
  });

  it.each([
    ["an <if> branch", "<p><if=input.c>${input.x}</if></p>"],
    ["an <else> branch", "<p><if=input.c>a</if><else>${input.x}</else></p>"],
    ["a <for> body", "<ul><for|i| of=input.l>${i}</for></ul>"],
    ["a component body", "<const/C=input.C/>\n<C>${input.x}</C>"],
    ["a render-prop body", "<const/C=input.C/>\n<C|v|>${v}</C>"],
    ["a <@catch> body", "<try><p>a</p><@catch|e|>${input.x}</@catch></try>"],
    [
      "a <@placeholder> body",
      "<try><p>a</p><@placeholder>${input.x}</@placeholder></try>",
    ],
  ])("wraps a lone placeholder as %s", (_name, source) => {
    const { code } = compileHonoMx(source, "/x/App.mx");
    expect(code.match(/__mxTextValue\(/g)).toHaveLength(1);
  });

  it("keeps a comma expression as one argument", () => {
    for (const source of [
      "<p>${(0, input.x)}</p>",
      "<p>${0, input.x}</p>",
      "<p><if=input.c>${(0, input.x)}</if></p>",
    ]) {
      const { code } = compileHonoMx(source, "/x/App.mx");
      expect(code).toContain("__mxTextValue((0, input.x))");
      expect(code).not.toContain("__mxTextValue(0, input.x)");
    }
  });

  it("is not emitted for a module without a placeholder", () => {
    expect(compileHonoMx("<p>text</p>", "/x/App.mx").code).not.toContain(
      "__mxTextValue",
    );
  });
});
