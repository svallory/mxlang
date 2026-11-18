// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomTag } from "@mxlang/core";
import { afterAll, describe, expect, it } from "vitest";
import { loadMx, type MxOptions, mx } from "./helpers.ts";
import { compile, TranslateError } from "./index.ts";

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

// A dialect's tag rules come from its discovered package, so each preset
// gets its own project dir with a test dialect for `.tst` files.
const dialectPage = (tagRules: string) => {
  const project = join(dir, `dialect-${tagRules}`);
  const packageDir = join(project, "node_modules", "test-dialect");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "test-dialect",
      mx: {
        dialect: {
          id: "test",
          name: "Test",
          extensions: [".tst"],
          module: "./index.mjs",
        },
      },
    }),
  );
  writeFileSync(
    join(packageDir, "index.mjs"),
    `export default { tagRules: ${JSON.stringify(tagRules)}, table: {} };\n`,
  );
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "app",
      devDependencies: { "test-dialect": "0.0.0" },
    }),
  );
  return join(project, "page.tst");
};

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

/**
 * `<html-style>`: stock Marko 6.4.4 compiles it to `<style attrs>` keeping
 * every attribute; the body is text with `${…}` stringified and `</style`
 * (any case) escaped to `\3C/style` (`_escape_style`), never HTML-escaped:
 *
 *   <html-style media="print">a > b { color: ${x} }</html-style>
 *     -> <style media=print>a > b { color: … }</style>
 */
describe("<html-style> keeps its attributes and escapes its body for style context", () => {
  it("keeps the attributes", () => {
    expect(
      render('<html-style media="print" data-x=input.y>a{}</html-style>', {
        y: "a b",
      }),
    ).toBe('<style media="print" data-x="a b">a{}</style>');
  });

  it.each([
    ["0", 0, "0"],
    ["null", null, ""],
    ["a string with `&`", "red&", "red&"],
  ])(
    "a placeholder holding %s prints as Marko's text placeholder",
    (_n, value, text) => {
      expect(
        render("<html-style>a { color: [${input.c}] }</html-style>", {
          c: value,
        }),
      ).toBe(`<style>a { color: [${text}] }</style>`);
    },
  );

  it("`</style` cannot close the element, in text or a placeholder", () => {
    expect(
      render("<html-style>a</STYLE>${input.v}</html-style>", {
        v: "</style>",
      }),
    ).toBe("<style>a\\3C/STYLE>\\3C/style></style>");
  });
});

/**
 * The core `<style>` refuses every attribute, a spread included, at the first
 * one (stock Marko 6.4.4's `assertNoStyleAttributes`); this target writes
 * `<style>` without them, so one would be dropped silently. The parser's
 * extension shorthand (`<style.less>`) is not an attribute.
 */
describe("<style> refuses attributes, as stock Marko does", () => {
  const message =
    "The `style` does not support html attributes. For a native html [`<style>` tag](https://markojs.com/docs/reference/core-tag#style) use the `html-style` core tag instead.";
  const refusal = (source: string) => {
    try {
      compile(source, "/fixtures/test.mx");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslateError);
      const { diagnosticCode, line, column } = error as TranslateError;
      return {
        message: (error as Error).message,
        diagnosticCode,
        line,
        column,
      };
    }
    throw new Error(`${source} compiled`);
  };

  it.each([
    ['<style media="print">a{}</style>', 7],
    ["<style ...input.a>a{}</style>", 7],
    ["<style scoped>a{}</style>", 7],
    ["<style a=1 b=2>a{}</style>", 7],
    ["<style#a>a{}</style>", 7],
    ['<style.a class="b">a{}</style>', 9],
  ])("%s is refused at the first attribute", (source, column) => {
    expect(refusal(source)).toEqual({
      message,
      diagnosticCode: "MX_INVALID_ATTRIBUTE",
      line: 1,
      column,
    });
  });

  it("refuses the arguments before the attributes, as stock does", () => {
    expect(refusal('<style(x) media="print">a{}</style>')).toEqual({
      message: "Tag does not support arguments.",
      diagnosticCode: "MX_UNSUPPORTED_CONSTRUCT",
      line: 1,
      column: 7,
    });
  });

  it("a custom tag's own attributes are not the `<style>` it emits", () => {
    expect(
      mx('<widget a="1"/>', {
        customTags: {
          widget: {
            attributes: { a: { type: "string" } },
            transform: (_call, ctx) => [
              ctx.build.delegatedTag("style", [], []),
            ],
          },
        },
      })({}),
    ).toBe("<style></style>");
  });

  it("refuses the attributes a custom tag builds on the `<style>` it emits", () => {
    expect(() =>
      mx('<widget media="print"/>', {
        customTags: {
          widget: {
            attributes: { media: { type: "string" } },
            transform: (call, ctx) => [
              ctx.build.delegatedTag("style", [], [], call.attrs),
            ],
          },
        },
      })({}),
    ).toThrow(
      expect.objectContaining({
        message:
          "`<widget>`: The `style` does not support html attributes. For a native html [`<style>` tag](https://markojs.com/docs/reference/core-tag#style) use the `html-style` core tag instead.",
        diagnosticCode: "MX_TAG_HOOK_ERROR",
        line: 1,
        column: 8,
      }),
    );
  });

  it.each([
    [
      "attribute tags",
      "<widget><@item/></widget>",
      {
        widget: {
          attributeTags: { item: {} },
          transform: (_call, ctx) => [ctx.build.delegatedTag("style", [], [])],
        },
      },
    ],
    [
      "tag params",
      "<widget|x|>a</widget>",
      {
        widget: {
          transform: (_call, ctx) => [ctx.build.delegatedTag("style", [], [])],
        },
      },
    ],
  ] satisfies [string, string, MxOptions["customTags"]][])(
    "a custom tag's own %s are not the `<style>` it builds",
    (_fields, source, customTags) => {
      expect(mx(source, { customTags })({})).toBe("<style></style>");
    },
  );

  // The authored `<style>`'s own fields are still refused, claimed or under a
  // contract-only `style` registration. (`<style><@a/></style>` is no field:
  // the body is text.)
  it.each([
    [
      "<style|x|>a{}</style>",
      "tag params `|...|` on `<style>` are not supported in a standalone template",
      0,
    ],
    [
      "<style/v>a{}</style>",
      "tag variable `/v` on `<style>` is not supported in a standalone template",
      7,
    ],
  ])("refuses the fields of %s", (source, message, column) => {
    expect(refusal(source)).toEqual({
      message,
      diagnosticCode: "MX_UNSUPPORTED_CONSTRUCT",
      line: 1,
      column,
    });
  });

  it("refuses the params of a contract-only `style` call", () => {
    let caught: unknown;
    try {
      mx("<style|x|>a{}</style>", { customTags: { style: {} } })({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TranslateError);
    const { diagnosticCode, line, column } = caught as TranslateError;
    expect({
      message: (caught as Error).message,
      diagnosticCode,
      line,
      column,
    }).toEqual({
      message:
        "tag params `|...|` on `<style>` are not supported in a standalone template",
      diagnosticCode: "MX_UNSUPPORTED_CONSTRUCT",
      line: 1,
      column: 0,
    });
  });

  it.each(["<style.less>a{}</style>", "<style.module.css>a{}</style>"])(
    "%s is an extension, not an attribute",
    (source) => {
      expect(compile(source, "/fixtures/test.mx").code).toContain(
        "<style>a{}</style>",
      );
    },
  );

  it("the `none` tag rules skip the refusal, as for `<html-comment>`", () => {
    expect(
      compile('<style media="print">a{}</style>', dialectPage("none")).code,
    ).toContain("<style>a{}</style>");
  });

  it("the `markup` tag rules refuse, like `html`", () => {
    expect(() =>
      compile('<style media="print">a{}</style>', dialectPage("markup")),
    ).toThrow(
      expect.objectContaining({
        message,
        diagnosticCode: "MX_INVALID_ATTRIBUTE",
        line: 1,
        column: 7,
      }),
    );
  });

  // Under a `style` contract the attributes it accepts are the author's, and
  // are written on the open tag rather than dropped. `loadMx` compiles with
  // the discovered tags only, so these rows pass `customTags` through `mx`.
  const withContract = (
    source: string,
    attributes: Record<string, { type: "string"; default?: string }>,
    input: Record<string, unknown> = {},
  ) => mx(source, { customTags: { style: { attributes } } })(input);
  const nonce = { nonce: { type: "string" } } as const;

  it("a `style` contract turns the refusal off and writes the attribute", () => {
    expect(withContract('<style nonce="abc">a{}</style>', nonce)).toBe(
      '<style nonce="abc">a{}</style>',
    );
  });

  it("a contract's dynamic attribute is written HTML-escaped", () => {
    expect(
      withContract("<style nonce=input.n>a{}</style>", nonce, { n: 'x"y' }),
    ).toBe('<style nonce="x&quot;y">a{}</style>');
  });

  it("a contract's default is written", () => {
    expect(
      withContract("<style>a{}</style>", {
        media: { type: "string", default: "print" },
      }),
    ).toBe('<style media="print">a{}</style>');
  });
});

/**
 * `<html-comment>`, `<html-script>` and `<html-style>` have no attribute tags
 * or params; core refuses them on the authored tag. A custom tag whose hook
 * builds one of them keeps its own: they are the custom tag's, not the built
 * primitive's.
 */
describe("a custom tag's own fields are not the raw primitive it builds", () => {
  type CustomTags = NonNullable<MxOptions["customTags"]>;
  const builds = (
    name: string,
    attributeTags?: CustomTags[string]["attributeTags"],
  ): CustomTags => ({
    widget: {
      ...(attributeTags ? { attributeTags } : {}),
      transform: (_call, ctx) => [ctx.build.delegatedTag(name, [], [])],
    },
  });

  it.each([
    ["html-comment", "<!---->"],
    ["html-script", "<script></script>"],
    ["html-style", "<style></style>"],
  ])("<%s>: the widget's tag params", (name, rendered) => {
    expect(mx("<widget|x|>a</widget>", { customTags: builds(name) })({})).toBe(
      rendered,
    );
  });

  it.each([
    ["html-comment", "<!---->"],
    ["html-script", "<script></script>"],
    ["html-style", "<style></style>"],
  ])("<%s>: the widget's attribute tags", (name, rendered) => {
    expect(
      mx("<widget><@item/></widget>", {
        customTags: builds(name, { item: {} }),
      })({}),
    ).toBe(rendered);
  });

  // The authored tags' fields are still refused, claimed or under a
  // contract-only registration, with the text and position they had.
  const refusal = (run: () => unknown) => {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TranslateError);
    const { diagnosticCode, line, column } = caught as TranslateError;
    return { message: (caught as Error).message, diagnosticCode, line, column };
  };

  it.each([
    [
      "<html-comment|x|>a</html-comment>",
      "tag params `|...|` on `<html-comment>` are not supported in a standalone template",
      0,
    ],
    [
      "<html-comment/v>a</html-comment>",
      "tag variable `/v` on `<html-comment>` is not supported in a standalone template",
      14,
    ],
    [
      "<html-comment(1)>a</html-comment>",
      "Tag does not support arguments.",
      14,
    ],
    [
      "<html-script|x|>a</html-script>",
      "tag params `|...|` on `<html-script>` are not supported in a standalone template",
      0,
    ],
    [
      "<html-style/v>a</html-style>",
      "tag variable `/v` on `<html-style>` is not supported in a standalone template",
      12,
    ],
  ])("refuses the fields of an authored %s", (source, message, column) => {
    expect(refusal(() => compile(source, "/fixtures/test.mx"))).toEqual({
      message,
      diagnosticCode: "MX_UNSUPPORTED_CONSTRUCT",
      line: 1,
      column,
    });
  });

  it("refuses the params of a contract-only `html-comment` call", () => {
    expect(
      refusal(() =>
        mx("<html-comment|x|>a</html-comment>", {
          customTags: { "html-comment": {} },
        })({}),
      ),
    ).toEqual({
      message:
        "tag params `|...|` on `<html-comment>` are not supported in a standalone template",
      diagnosticCode: "MX_UNSUPPORTED_CONSTRUCT",
      line: 1,
      column: 0,
    });
  });
});

/**
 * Under the `none` tag rules `let`, `server` and `client` are ordinary tag
 * names, so this host does not claim them there: a built one is refused as an
 * unclaimed name, and an authored one takes an ordinary tag's route. Nor does
 * core apply this host's rows (`TAGS`, and the strict policy's) for a name
 * that is not reserved: such a tag compiles as the ordinary `<zzz>` does, and
 * `<script>`, a web element, as the ordinary element `<span>` does.
 */
describe("the `none` tag rules: host rows and `let`, `server`, `client` are ordinary", () => {
  const builds = (name: string): CustomTag => ({
    transform: (_call, ctx) => [ctx.build.delegatedTag(name, [], [])],
  });

  it.each(["let", "server", "client"])(
    "a custom tag that builds `<%s>` is refused as unclaimed",
    (name) => {
      expect(() =>
        compile("<widget/>", dialectPage("none"), {
          customTags: { widget: builds(name) },
        }),
      ).toThrow(
        expect.objectContaining({
          message: `\`<widget>\`: this host does not claim \`<${name}>\`, so a custom tag cannot emit one`,
          diagnosticCode: "MX_TAG_HOOK_ERROR",
          line: 1,
          column: 0,
        }),
      );
    },
  );

  const outcome = (
    source: string,
    options?: Parameters<typeof compile>[2],
    page = dialectPage("none"),
  ) => {
    try {
      return { code: compile(source, page, options).code };
    } catch (caught) {
      const { message, diagnosticCode } = caught as TranslateError;
      return { message, diagnosticCode };
    }
  };

  // The control is the same source with the name swapped for an ordinary
  // one: `<zzz>` for a tag, `<span>` for `<script>`, which is a web element.
  const asControl = (
    shape: (name: string) => string,
    name: string,
    options?: Parameters<typeof compile>[2],
  ) => {
    const ordinary = name === "script" ? "span" : "zzz";
    return JSON.parse(
      JSON.stringify(outcome(shape(ordinary), options)).replaceAll(
        ordinary,
        name,
      ),
    );
  };
  const withBody = (name: string) => `<${name} a=1>x</${name}>`;
  const bare = (name: string) => `<${name}/>`;
  const textBody = (name: string) => `<${name}>x</${name}>`;

  it.each(["server", "client"])(
    "an authored `<%s>` compiles as the ordinary `<zzz>` does",
    (name) => {
      expect(outcome(textBody(name))).toEqual(asControl(textBody, name));
    },
  );

  it.each(
    ["lifecycle", "id", "log", "debug", "await", "script"].flatMap((name) => [
      [withBody(name), name, withBody] as const,
      [bare(name), name, bare] as const,
    ]),
  )(
    "an authored `%s` compiles as its ordinary control",
    (source, name, shape) => {
      expect(outcome(source)).toEqual(asControl(shape, name));
    },
  );

  it.each([
    "effect",
    "let",
    "client",
    "lifecycle",
    "id",
    "log",
    "debug",
    "await",
    "script",
  ])(
    "under the strict policy an authored `<%s a=1>x</…>` compiles as its ordinary control",
    (name) => {
      expect(outcome(withBody(name), { strict: true })).toEqual(
        asControl(withBody, name, { strict: true }),
      );
    },
  );

  it.each([
    [
      "<log a=1/>",
      {
        message:
          "`<log>` does not support the `a` attribute; it emits nothing, so the attribute would be silently discarded",
        diagnosticCode: "MX_INERT_TAG_SHAPE",
      },
    ],
    [
      "<await/>",
      {
        message:
          "`<await>` suspends on a promise; this target is a synchronous `(input) => string` and cannot await",
        diagnosticCode: "MX_UNSUPPORTED_CONSTRUCT",
      },
    ],
  ])(
    "the `markup` tag rules still apply this host's row to `%s`",
    (source, refusal) => {
      expect(outcome(source, undefined, dialectPage("markup"))).toEqual(
        refusal,
      );
    },
  );
});
