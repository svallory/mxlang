import { describe, expect, it } from "vitest";
import { compile, mx } from "./index.ts";

/**
 * Marko 6.4.4 rejects an attribute name outside `[a-z_$][a-z0-9._:-]*`
 * ("Invalid attribute name.", `runtime-tags/.../pre-analyze.ts` `normalizeTag`).
 * Angular template syntax (`[prop]=`, `#ref`, `*ngIf`) is not Marko, so every
 * non-Angular host must fail at the authored name, not pass it through.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

function failure(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compile(source, "/fixtures/test.mx");
  } catch (error) {
    const e = error as { message: string; line: number; column: number };
    return {
      message: e.message.replace(ANSI, ""),
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("invalid attribute names (html)", () => {
  it.each([
    ["[prop]", '<div [prop]="x">hi</div>', 5, "write `prop=`"],
    ["[attr.x]", '<div [attr.x]="y"/>', 5, "write `x=`"],
    ["[class.a]", '<div [class.a]="y"/>', 5, "class={ a: cond }"],
    ["*ngIf", '<div *ngIf="x"/>', 5, "<if=cond>"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal mx source
    ["$foo", "<${input.tag} $foo=1/>", 14, "attribute name"],
    ["@foo", '<div @foo="y"/>', 5, "attribute name"],
    // Stock Marko: a spaced `#ref` or `.cls` is an attribute name outside its
    // grammar; the hint points at the tag-adjacent shorthand.
    ["#ref", "<div #ref/>", 5, "goes on the tag name"],
    [".cls", "<div .cls/>", 5, "goes on the tag name"],
  ])("rejects %s at the authored name", (name, source, column, hint) => {
    const error = failure(source);
    expect(error.message).toContain(`Invalid attribute name \`${name}\``);
    expect(error.message).toContain(hint);
    expect(error).toMatchObject({ line: 1, column });
  });

  it("positions on the right line and column in a multi-line tag", () => {
    const error = failure(
      '<section>\n  <div class="a"\n       [prop]="x"/>\n</section>',
    );
    expect(error).toMatchObject({ line: 3, column: 7 });
  });

  it("accepts the names Marko accepts", () => {
    for (const ok of [
      '<div data-x="1"/>',
      '<div aria-label="l"/>',
      '<div a.b="1"/>',
      '<div _x="1"/>',
    ]) {
      expect(() => failure(ok)).toThrow("expected a compile error");
    }
  });
});

/**
 * Marko's parser (`babel-plugin/parser.js`, `onAttrName`) splits an attribute
 * name at its LAST `:` and fills an empty head with `value`, so
 * `<div :foo="y"/>` is not a modifier: it is the attribute literally named
 * `value:foo`, which Marko compiles and renders as `<div value:foo=y>`.
 * Only native `class:`, `style:` and `on:` prefixes are reserved; every other
 * colon name, such as `x:foo` or `data:x`, is an ordinary attribute.
 *
 * The bare `:foo` is the same attribute, `value:foo`.
 *
 * Plain HTML carries the name verbatim, so this host renders exactly what
 * Marko renders. `expected.html` in the `attr-value-modifier` fixture is
 * stock Marko's own output (`bun run oracle:marko`).
 */
describe("`:modifier` is the attribute `value:modifier` (html)", () => {
  const rendered = (source: string): string =>
    compile(source, "/fixtures/test.mx").code;

  it("renders Marko's attribute, for every value kind", () => {
    expect(rendered(`<div value:foo="lit"/>`)).toContain(
      `__mxOut.write("<div value:foo=\\"lit\\"></div>");`,
    );
    expect(rendered(`<div value:foo/>`)).toContain(
      `__mxOut.write("<div value:foo=\\"\\"></div>");`,
    );
    expect(rendered(`<div :foo/>`)).toContain(
      `__mxOut.write("<div value:foo=\\"\\"></div>");`,
    );
  });

  it.each([
    ["<div value:/>", '__mxOut.write("<div value:=\\"\\"></div>");'],
    ["<div x:/>", '__mxOut.write("<div x:=\\"\\"></div>");'],
    ['<div x: = "s"/>', '__mxOut.write("<div x:=\\"s\\"></div>");'],
    [
      '<div value:foo:bar="y"/>',
      '__mxOut.write("<div value:foo:bar=\\"y\\"></div>");',
    ],
    [
      "<div value:foo:bar/>",
      '__mxOut.write("<div value:foo:bar=\\"\\"></div>");',
    ],
  ])("renders the full colon name: %s", (source, output) => {
    expect(rendered(source)).toContain(output);
  });

  it.each([
    "x:foo",
    "data:x",
    "prop:x",
    "attr:x",
    "bool:x",
    "use:x",
    "oncapture:click",
    "x:foo:bar",
  ])("renders ordinary colon names without renaming them: %s", (name) => {
    for (const [suffix, value] of [
      ["", ""],
      ['="y"', "y"],
    ]) {
      expect(rendered(`<div ${name}${suffix}/>`)).toContain(
        `__mxOut.write(${JSON.stringify(`<div ${name}="${value}"></div>`)});`,
      );
    }
    expect(rendered(`<div ${name}=input.x/>`)).toContain(
      `__mxRenderAttr("${name}", input.x, "div")`,
    );
  });

  it.each([
    ["<div x:() {}/>", "The `x:` attribute cannot be a function.", 1, 5],
    [
      "<div value:foo() {}/>",
      "The `value:foo` attribute cannot be a function.",
      1,
      5,
    ],
    ["<div x:foo() {}/>", "The `x:foo` attribute cannot be a function.", 1, 5],
    [
      "<div\n  x:foo() {}\n/>",
      "The `x:foo` attribute cannot be a function.",
      2,
      2,
    ],
    [
      "<div x:foo=(function(){})/>",
      "The `x:foo` attribute cannot be a function.",
      1,
      5,
    ],
    [
      "<div x:foo=(() => {})/>",
      "The `x:foo` attribute cannot be a function.",
      1,
      5,
    ],
    [
      "<div x:foo=function fn() {}/>",
      "The `x:foo` attribute cannot be a function.",
      1,
      5,
    ],
    [
      "<div x:foo()=(() => {})/>",
      "The `x:foo` attribute cannot be a function.",
      1,
      5,
    ],
    [
      "<div\n  x:foo=(function(){})\n/>",
      "The `x:foo` attribute cannot be a function.",
      2,
      2,
    ],
    [
      '<div x:foo()="y"/>',
      "Unsupported arguments on the `x:foo` attribute.",
      1,
      5,
    ],
    ['<div x:()="y"/>', "Unsupported arguments on the `x:` attribute.", 1, 5],
    [
      '<div\n  x:foo()="y"\n/>',
      "Unsupported arguments on the `x:foo` attribute.",
      2,
      2,
    ],
    [
      '<div :="x"/>',
      "Attributes may only be bound to identifiers or member expressions",
      1,
      7,
    ],
    [
      '<div\n  :="x"/>',
      "Attributes may only be bound to identifiers or member expressions",
      2,
      4,
    ],
    [
      '<div value:foo()="y"/>',
      "Unsupported arguments on the `value:foo` attribute.",
      1,
      5,
    ],
    [
      '<div\n  value:foo()="y"/>',
      "Unsupported arguments on the `value:foo` attribute.",
      2,
      2,
    ],
  ])(
    "reports Marko's exact error at its position: %s",
    (source, message, line, column) => {
      expect(failure(source)).toEqual({ message, line, column });
    },
  );

  it("keeps an empty suffix on a dynamic attribute", () => {
    expect(rendered("<div x: = input.x/>")).toContain("x:");
  });

  it.each(["class", "style", "on"])("refuses an empty %s modifier", (name) => {
    expect(failure(`<div ${name}:/>`).message).toContain(`\`${name}:`);
  });

  it.each([
    ["class:foo:bar", "class={ foo:bar: condition }"],
    ["style:foo:bar", "style={ foo:bar: value }"],
    ["on:foo:bar", "onFoo:bar"],
  ])(
    "uses Marko's exact reserved-head fix-it and position: %s",
    (name, suggestion) => {
      for (const suffix of ["", '="x"', "=input.x"]) {
        for (const [gap, line, column] of [
          [" ", 1, 5],
          ["\n  ", 2, 2],
        ] as const) {
          expect(failure(`<div${gap}${name}${suffix}/>`)).toEqual({
            message: `\`${name}\` is not a valid attribute, did you mean \`${suggestion}\`?`,
            line,
            column,
          });
        }
      }
    },
  );

  it("still refuses a real modifier, in Marko's words", () => {
    const error = failure(`<div class:active="x"/>`);
    expect(error.message).toContain(
      "`class:active` is not a valid attribute, did you mean `class={ active: condition }`?",
    );
    expect(error).toMatchObject({ line: 1, column: 5 });
  });
});

/**
 * Marko 6.4.4 refuses a string `by=` outside `of` and refuses `key=` on a
 * `<for>` at all (`runtime-tags/src/translator/core/for.ts`); MX was silent on
 * both, which is the S8 silent-drop class — the loop key the author wrote was
 * read by nothing. Reported through this host's own surface, at the position
 * Marko uses: the quoted key for the string `by`, the attribute for `key=`.
 */
describe("`<for>` by=/key= (html)", () => {
  it("refuses a string `by=` outside `of`, at the quoted key", () => {
    const error = failure(`<for|k, v| in=o by="id"><p/></for>`);
    expect(error.message).toContain(
      "only supports a string `by` key with `of`; use a `by=(key, value) => ...` function for `<for in>`",
    );
    expect(error).toMatchObject({ line: 1, column: 19 });

    expect(failure(`<for|i| to=3 by="id"><p/></for>`)).toMatchObject({
      column: 16,
    });
    expect(failure(`<for|i| until=3 by="id"><p/></for>`)).toMatchObject({
      column: 19,
    });
    expect(failure(`<for|i| to=3 by="id"><p/></for>`).message).toContain(
      "use a `by=(index) => ...` function for `<for to>`",
    );
  });

  it("redirects `key=` to `by=`, at the attribute", () => {
    const of = failure(`<for|x| of=xs key="id"><p/></for>`);
    expect(of.message).toContain(
      'keys items with the `by=` attribute, not `key=`. Use `by="propName"` or `by=(item, index) => key`',
    );
    expect(of).toMatchObject({ line: 1, column: 14 });

    expect(failure(`<for|k, v| in=o key="id"><p/></for>`).message).toContain(
      "Use `by=(key, value) => key`",
    );
    expect(failure(`<for|i| to=3 key="id"><p/></for>`).message).toContain(
      "Use `by=(num) => key`",
    );
  });

  it("keeps the forms Marko keeps", () => {
    for (const ok of [
      `<for|x| of=xs by="id"><p>{x.id}</p></for>`,
      `<for|k, v| in=o by=(k) => k><p>{v}</p></for>`,
      `<for|i| to=3 by=(i) => i><p>{i}</p></for>`,
      `<for|i| until=3 by=(i) => i><p>{i}</p></for>`,
    ]) {
      expect(() => failure(ok)).toThrow("expected a compile error");
    }
  });
});

/**
 * A colon in a tag head, or a spaced `#id` / `.class`, reads as stock Marko
 * reads it (`@marko/compiler` 5.42.11 on the stock `htmljs-parser` 5.18.0):
 * `:` is a tag-name and shorthand character, an empty head before a `:` is
 * the default attribute's `value:`, and a spaced `#`/`.` name is outside
 * Marko's attribute grammar. These pin the HTML or the error each form gives.
 */
describe("a colon or a spaced shorthand reads as Marko reads it (html)", () => {
  const html = (source: string): string =>
    compile(source, "/fixtures/test.mx").code.match(
      /__mxOut\.write\((".*")\);/,
    )?.[1] ?? "";
  const rendered = (source: string): string => JSON.parse(html(source));

  it.each([
    ["<a.c:b/>", '<a class="c:b"></a>'],
    ["<a#d:b.c/>", '<a class="c" id="d:b"></a>'],
    ["<a.c:b#d/>", '<a class="c:b" id="d"></a>'],
    ["<a.hover:x/>", '<a class="hover:x"></a>'],
    ['<a class="hover:x"/>', '<a class="hover:x"></a>'],
    ["<a :b/>", '<a value:b=""></a>'],
    ["<a :1/>", '<a value:1=""></a>'],
    ["<div.a.b#m/>", '<div class="a b" id="m"></div>'],
  ])("%s", (source, expected) => {
    expect(rendered(source)).toBe(expected);
  });

  // `<kind:name>` is one tag name. On a statement keyword it used to become a
  // statement node in the body, which this target reported as an internal
  // error; it is now Marko's custom-tag error, positioned at the tag.
  it.each([
    ['<input:email type="email"/>', "<input:email>", 0],
    ["<:email/>", "<:email>", 0],
    ["<a:b.c#d/>", "<a:b>", 0],
    ["<import:x/>", "<import:x>", 0],
    ["<div><import:x/></div>", "<import:x>", 5],
    ["<div><export:x/></div>", "<export:x>", 5],
    ["<div><static:x/></div>", "<static:x>", 5],
  ])("%s is one tag name, Marko's custom-tag error", (source, tag, column) => {
    const error = failure(source);
    expect(error.message).toContain(
      `Unable to find entry point for custom tag \`${tag}\``,
    );
    expect(error).toMatchObject({ line: 1, column });
  });

  it.each([
    ["<a #b/>", "#b", 3],
    ["<a .b/>", ".b", 3],
    ['<a x="1" #b/>', "#b", 9],
    ["<input .c=1/>", ".c", 7],
    ["input #x=1", "#x", 6],
  ])(
    "%s: a spaced shorthand is Marko's invalid attribute name",
    (source, name, column) => {
      const error = failure(source);
      expect(error.message).toContain(`Invalid attribute name \`${name}\``);
      expect(error).toMatchObject({ line: 1, column });
    },
  );

  it("` :b` after a value continues it: Marko's single-expression error", () => {
    let thrown:
      | { message: string; loc?: { start: { line: number; column: number } } }
      | undefined;
    try {
      compile('<a x="1" :b/>', "/fixtures/test.mx");
    } catch (error) {
      thrown = error as typeof thrown;
    }
    expect(thrown?.message.replace(ANSI, "")).toContain(
      "Expected a single expression, but found `:` after it.",
    );
    expect(thrown?.loc?.start).toMatchObject({ line: 1, column: 9 });
  });

  it("` .c` after a value is member access on it", () => {
    const code = (source: string) => compile(source, "/fixtures/test.mx").code;
    expect(code("<a x=input.a .c/>")).not.toContain('class=\\"c\\"');
    expect(code("<a x=input.a .c/>")).toContain("input.a .c");
  });
});

// A tag-adjacent shorthand then `=value` or `(params) { body }` sets the
// default attribute (`value`), as in Marko.
describe("a tag-adjacent shorthand followed by =value sets the default attribute (html)", () => {
  const render = (
    source: string,
    input: Record<string, unknown> = {},
  ): string => mx(source, { filename: "/fixtures/render.mx" })(input);

  it.each([
    ["<input#x=1/>", '<input value="1" id="x">'],
    ["<input#x=input.y/>", '<input value="Y" id="x">'],
    ['<input.c="s"/>', '<input value="s" class="c">'],
    [
      '<input.c#x=2 type="text"/>',
      '<input value="2" type="text" class="c" id="x">',
    ],
    ["input#x=1", '<input value="1" id="x">'],
  ])("%s", (source, expected) => {
    expect(render(source, { y: "Y" })).toBe(expected);
  });

  it("a method has no runtime in a string target, positioned at the `(`", () => {
    const error = failure("<input#x(e) { e }/>");
    expect(error.message).toContain("attribute method");
    expect(error).toMatchObject({ line: 1, column: 8 });
  });
});
