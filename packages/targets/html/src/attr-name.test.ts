import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

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
    ["#ref", "<div #ref/>", 5, "reference"],
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
 * Plain HTML carries the name verbatim, so this host renders exactly what
 * Marko renders. `expected.html` in the `attr-value-modifier` fixture is
 * stock Marko's own output (`bun run oracle:marko`).
 */
describe("`:modifier` is the attribute `value:modifier` (html)", () => {
  const rendered = (source: string): string =>
    compile(source, "/fixtures/test.mx").code;

  it("renders Marko's attribute, for every value kind", () => {
    expect(rendered(`<div :foo="lit"/>`)).toContain(
      `__mxOut += "<div value:foo=\\"lit\\"></div>";`,
    );
    expect(rendered(`<div :foo/>`)).toContain(
      `__mxOut += "<div value:foo=\\"\\"></div>";`,
    );
    // The same attribute under its long spelling: Marko compiles
    // `<div value:foo="y"/>` to the same output as `<div :foo="y"/>`.
    expect(rendered(`<div value:foo="lit"/>`)).toContain(
      `__mxOut += "<div value:foo=\\"lit\\"></div>";`,
    );
  });

  it.each([
    ["<div :/>", '__mxOut += "<div value:=\\"\\"></div>";'],
    ["<div x:/>", '__mxOut += "<div x:=\\"\\"></div>";'],
    ['<div x: = "s"/>', '__mxOut += "<div x:=\\"s\\"></div>";'],
    [
      '<div value:foo:bar="y"/>',
      '__mxOut += "<div value:foo:bar=\\"y\\"></div>";',
    ],
    ["<div value:foo:bar/>", '__mxOut += "<div value:foo:bar=\\"\\"></div>";'],
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
        `__mxOut += ${JSON.stringify(`<div ${name}="${value}"></div>`)};`,
      );
    }
    expect(rendered(`<div ${name}=input.x/>`)).toContain(
      `__mxRenderAttr("${name}", input.x, "div")`,
    );
  });

  it.each([
    ["<div x:() {}/>", "The `x:` attribute cannot be a function.", 1, 5],
    [
      "<div :foo() {}/>",
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
      '<div :foo()="y"/>',
      "Unsupported arguments on the `value:foo` attribute.",
      1,
      5,
    ],
    [
      '<div\n  :foo()="y"/>',
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
