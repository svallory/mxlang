import { describe, expect, it } from "vitest";
import { compile, mx } from "./index.ts";

/**
 * Marko 6.3.51 rejects an attribute name outside `[a-z_$][a-z0-9._:-]*`
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
  ])("rejects %s at the authored name", (name, source, column, hint) => {
    const error = failure(source);
    expect(error.message).toContain(`Invalid attribute name \`${name}\``);
    expect(error.message).toContain(hint);
    expect(error).toMatchObject({ line: 1, column });
  });

  // Decision 146: `#ref` is `id="ref"` sugar, not Angular's reference.
  it("reads `#ref` as `id` sugar", () => {
    expect(compile("<div #ref/>", "/fixtures/test.mx").code).toContain(
      `__mxOut.write("<div id=\\"ref\\"></div>");`,
    );
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
 * Decision 146 made the bare `:foo` spelling `name="foo"` sugar; the explicit
 * `value:foo` below is still Marko's attribute.
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
    // Decision 146: the bare spelling is `name` sugar.
    expect(rendered(`<div :foo/>`)).toContain(
      `__mxOut.write("<div name=\\"foo\\"></div>");`,
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
 * Marko 6.3.51 refuses a string `by=` outside `of` and refuses `key=` on a
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
 * Decision 146: `:name`, `#id` and `.class` sugar, rendered. The IR rows are in
 * `packages/core/src/name-sugar.test.ts`; these pin the HTML each position
 * produces, in HTML and concise mode.
 */
describe("name sugar renders (html)", () => {
  const html = (source: string): string =>
    compile(source, "/fixtures/test.mx").code.match(
      /__mxOut\.write\((".*")\);/,
    )?.[1] ?? "";
  const rendered = (source: string): string => JSON.parse(html(source));

  it.each([
    ['<input:email type="email"/>', '<input name="email" type="email">'],
    ["<:email/>", '<div name="email"></div>'],
    ["<a.c:b/>", '<a name="b" class="c"></a>'],
    ["<a#d:b.c/>", '<a name="b" class="c" id="d"></a>'],
    ["<a.c:b#d/>", '<a name="b" class="c" id="d"></a>'],
    ["<a:b.c#d/>", '<a name="b" class="c" id="d"></a>'],
    ["<a.hover:x/>", '<a name="x" class="hover"></a>'],
    ['<a class="hover:x"/>', '<a class="hover:x"></a>'],
    ["<a :b/>", '<a name="b"></a>'],
    ['<a x="1" :b/>', '<a x="1" name="b"></a>'],
    ["<a #b/>", '<a id="b"></a>'],
    ["<a .b/>", '<a class="b"></a>'],
    ['<a x="1" #b/>', '<a x="1" id="b"></a>'],
    ['<a x="1" .b/>', '<a x="1" class="b"></a>'],
    ["<div.a #m .b/>", '<div class="a b" id="m"></div>'],
    ["<div.a.b#m/>", '<div class="a b" id="m"></div>'],
    ['a x="1" #b .c :d', '<a x="1" id="b" class="c" name="d"></a>'],
  ])("%s", (source, expected) => {
    expect(rendered(source)).toBe(expected);
  });

  it("`x=a.b .c` is two attributes, `x=(a.b .c)` is one value", () => {
    const code = (source: string) => compile(source, "/fixtures/test.mx").code;
    expect(code("<a x=input.a .c/>")).toContain('"x", input.a');
    expect(code("<a x=input.a .c/>")).toContain('class=\\"c\\"');
    expect(code("<a x=(input.a .c)/>")).not.toContain('class=\\"c\\"');
  });

  it.each([
    ["<a :1/>", "`:1`"],
    ["<a:b.c:d/>", "one `:name`"],
  ])("%s is a positioned error", (source, text) => {
    expect(failure(source).message).toContain(text);
  });
});

// Round 3, review B: a falsy literal beside a `.x` sugar renders as the
// tag-adjacent spelling does (Marko's class helper drops it).
describe("a literal class beside a `.x` sugar renders like the tag-adjacent class (html)", () => {
  const render = (source: string): string =>
    mx(source, { filename: "/fixtures/render.mx" })({});

  it.each([
    ["<div class=false .b/>", "<div.b class=false/>"],
    ["<div class=0 .b/>", "<div.b class=0/>"],
    ["<div class=null .b/>", "<div.b class=null/>"],
    ["<div .b class=false/>", "<div.b class=false/>"],
    ["<div class=1 .b/>", "<div.b class=1/>"],
    ["<div class=true .b/>", "<div.b class=true/>"],
  ])("%s", (sugar, adjacent) => {
    const classes = (html: string) =>
      [...(html.match(/class="([^"]*)"/)?.[1] ?? "").split(" ")].sort();
    expect(classes(render(sugar))).toEqual(classes(render(adjacent)));
  });

  it("drops the falsy literal", () => {
    expect(render("<div class=false .b/>")).toBe('<div class="b"></div>');
    expect(render("<div class=0 .b/>")).toBe('<div class="b"></div>');
  });
});

// Decision 146 addendum 4 (PR 4): a sugar followed by `=value` or
// `(params) { body }` sets the default attribute (`value`).
describe("a sugar followed by =value sets the default attribute (html)", () => {
  const render = (source: string, input: object = {}): string =>
    mx(source, { filename: "/fixtures/render.mx" })(input);

  it.each([
    ["<input #x=1/>", '<input value="1" id="x">'],
    ["<input :x=input.y/>", '<input value="Y" name="x">'],
    ["<input .c=1/>", '<input value="1" class="c">'],
    ['<input .c="s"/>', '<input value="s" class="c">'],
    ['<input type="text" #x=2/>', '<input value="2" type="text" id="x">'],
    ["input #x=1", '<input value="1" id="x">'],
    ["input :x=input.y", '<input value="Y" name="x">'],
    ["<input:x=1/>", '<input value="1" name="x">'],
    ["<input#x=1/>", '<input value="1" id="x">'],
  ])("%s", (source, expected) => {
    expect(render(source, { y: "Y" })).toBe(expected);
  });

  it("a method has no runtime in a string target, positioned at the `(`", () => {
    const error = failure("<input #x(e) { e }/>");
    expect(error.message).toContain("attribute method");
    expect(error.line).toBe(1);
  });

  it.each([
    ["<if=input.a #x=1>y</if>", 1, 15],
    ["<input=1 #x=2/>", 1, 12],
    ["input=1 #x=2", 1, 11],
  ])(
    "%s: a second default value is a positioned error at the second",
    (source, line, column) => {
      const error = failure(source);
      expect(error.message).toContain("already has a default value");
      expect([error.line, error.column]).toEqual([line, column]);
    },
  );
});
