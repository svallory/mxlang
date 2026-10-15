// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMx } from "./helpers.ts";
import { compile } from "./index.ts";

/**
 * `<html-script>` is the tag for a native html `<script>` element (the bare
 * `<script>` is client code and refuses attributes and placeholders). Stock
 * Marko 6.4.4 compiles it to a real `<script>` element that keeps every
 * attribute, and its body is text: a `${…}` placeholder is stringified like
 * any text placeholder, then the whole body is escaped for script context
 * (`_escape_script`: `<script`, `</script` and `<!--` become `\u003C…`),
 * never HTML-escaped. Probed against the stock parser:
 *
 *   <html-script type="module" data-x=y>const v = ${x};</html-script>
 *     -> <script type=module data-x=y>const v = …;</script>
 *   <html-script nonce=n>${"</script>"}</html-script>
 *     -> <script nonce=…>\u003C/script></script>
 *
 * Marko prints attributes unquoted where it can; this target always quotes, as
 * for every element, so the expected strings below quote them.
 */

const dir = mkdtempSync(
  join(new URL("..", import.meta.url).pathname, ".mx-html-script-tmp-"),
);
let serial = 0;
const render = (source: string, input: Record<string, unknown> = {}) => {
  const path = join(dir, `t${serial++}.mx`);
  writeFileSync(path, source);
  return loadMx<Record<string, unknown>>(path)(input);
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("<html-script> keeps its attributes", () => {
  it("static, dynamic and boolean attributes, in authored order", () => {
    expect(
      render(
        '<html-script type="module" data-x=input.y async>const v = 1;</html-script>',
        { y: "a b" },
      ),
    ).toBe('<script type="module" data-x="a b" async>const v = 1;</script>');
  });

  it("a self-closing script with src and async", () => {
    expect(render('<html-script async src="/a.js"/>')).toBe(
      '<script async src="/a.js"></script>',
    );
  });

  it("an attribute value is HTML-escaped as on any element", () => {
    expect(
      render("<html-script src=input.s></html-script>", { s: '/a?b=1&c="2"' }),
    ).toBe('<script src="/a?b=1&amp;c=&quot;2&quot;"></script>');
  });

  it("a false, null or undefined attribute is dropped", () => {
    expect(
      render(
        "<html-script defer=input.f data-n=input.n data-u=input.u src=input.s/>",
        { f: false, n: null, s: "/a.js" },
      ),
    ).toBe('<script src="/a.js"></script>');
  });

  it("a nonce the author gives is kept", () => {
    expect(
      render("<html-script nonce=input.n>go();</html-script>", { n: "k1" }),
    ).toBe('<script nonce="k1">go();</script>');
  });

  it("no nonce is invented when the author gives none", () => {
    expect(render("<html-script>go();</html-script>")).toBe(
      "<script>go();</script>",
    );
  });

  it("a spread contributes its attributes", () => {
    expect(
      render("<html-script ...input.a>go();</html-script>", {
        a: { type: "module", "data-k": "v" },
      }),
    ).toBe('<script type="module" data-k="v">go();</script>');
  });

  it("a later attribute wins over an earlier spread, as on any element", () => {
    expect(
      render('<html-script ...input.a type="text/plain">x</html-script>', {
        a: { type: "module", id: "s" },
      }),
    ).toBe('<script type="text/plain" id="s">x</script>');
  });

  it("the shared element rules apply: class and style values", () => {
    expect(
      render(
        '<html-script class=["a", input.f && "b"] style={color: "red"}>x</html-script>',
        { f: false },
      ),
    ).toBe('<script class="a" style="color:red">x</script>');
  });

  it("still refuses an event-handler attribute, as it does on any element", () => {
    expect(() =>
      compile("<html-script onclick() { go() }>x</html-script>", "t.mx"),
    ).toThrow(/event handler/);
  });
});

describe("<html-script> interpolates its body as script text", () => {
  it("a placeholder is stringified, not HTML-escaped", () => {
    expect(
      render("<html-script>const v = ${input.x};</html-script>", {
        x: `a<b&c"d'e>`,
      }),
    ).toBe(`<script>const v = a<b&c"d'e>;</script>`);
  });

  it("a placeholder inside a string literal of the script", () => {
    expect(
      render('<html-script>let a = "${input.s}";</html-script>', { s: "q" }),
    ).toBe('<script>let a = "q";</script>');
  });

  it("a `</script>` in a placeholder cannot close the element", () => {
    const html = render('<html-script nonce="n">${input.s}</html-script>', {
      s: "</script>",
    });
    expect(html).toBe('<script nonce="n">\\u003C/script></script>');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it.each([
    ["</script>", "\\u003C/script>"],
    ["</SCRIPT>", "\\u003C/SCRIPT>"],
    ["<script>", "\\u003Cscript>"],
    ["<Script src=x>", "\\u003CScript src=x>"],
    ["</scripts", "\\u003C/scripts"],
    ["<!--", "\\u003C!--"],
    ["a <!-- b </script> c", "a \\u003C!-- b \\u003C/script> c"],
    ["<b>&amp;</b>", "<b>&amp;</b>"],
    ["<", "<"],
    ["</scrip", "</scrip"],
  ])("a placeholder holding %j is written as %j", (value, written) => {
    expect(render("<html-script>${input.v}</html-script>", { v: value })).toBe(
      `<script>${written}</script>`,
    );
  });

  it("the static text of the body is escaped for script context too", () => {
    expect(
      render("<html-script>a</script>b <!-- c <SCRIPT</html-script>"),
    ).toBe("<script>a\\u003C/script>b \\u003C!-- c \\u003CSCRIPT</script>");
  });

  it("static text keeps its HTML entities and markup characters as written", () => {
    expect(
      render("<html-script>if (a < b && c > d) go('&amp;');</html-script>"),
    ).toBe("<script>if (a < b && c > d) go('&amp;');</script>");
  });

  it("the escape applies across text and placeholder boundaries", () => {
    // `<` ends the text run and `/script>` starts the placeholder's value:
    // each half alone is harmless, the joined body is not.
    expect(
      render("<html-script><${input.v}</html-script>", { v: "/script>" }),
    ).toBe("<script>\\u003C/script></script>");
  });

  it("a raw placeholder is escaped for script context as well", () => {
    expect(
      render("<html-script>$!{input.v}</html-script>", { v: "</script>" }),
    ).toBe("<script>\\u003C/script></script>");
  });

  it.each([
    ["false", false, ""],
    ["null", null, ""],
    ["undefined", undefined, ""],
    ["the empty string", "", ""],
    ["NaN", Number.NaN, ""],
    ["0", 0, "0"],
    ["1", 1, "1"],
    ["true", true, "true"],
  ])("%s prints as Marko's text placeholder does", (_name, value, text) => {
    expect(
      render("<html-script>[${input.v}]</html-script>", { v: value }),
    ).toBe(`<script>[${text}]</script>`);
  });

  it("a multi-line body keeps its lines and interpolates on each", () => {
    expect(
      render(
        "<html-script>\n  const a = ${input.a};\n  go(${input.b});\n</html-script>",
        { a: 1, b: "x" },
      ),
    ).toBe("<script>\n  const a = 1;\n  go(x);\n</script>");
  });

  it("two scripts in one template are independent", () => {
    expect(
      render(
        '<html-script id="a">${input.v}</html-script><html-script id="b">2</html-script>',
        { v: 1 },
      ),
    ).toBe('<script id="a">1</script><script id="b">2</script>');
  });

  it("a script inside an element and a loop", () => {
    expect(
      render(
        "<div><for|n| of=input.ns><html-script data-n=n>go(${n})</html-script></for></div>",
        { ns: [1, 2] },
      ),
    ).toBe(
      '<div><script data-n="1">go(1)</script><script data-n="2">go(2)</script></div>',
    );
  });
});

describe("<html-script> in the emitted module", () => {
  it("a body of static text only is escaped at compile time", () => {
    const code = compile("<html-script>a</script>b</html-script>", "t.mx").code;
    expect(code).toContain("a\\\\u003C/script>b");
  });
});
