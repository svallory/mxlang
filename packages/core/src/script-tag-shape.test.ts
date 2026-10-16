// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * The shape of a built-in `<script>`: no attribute but its own value, and no
 * `${…}` placeholder in its body.
 *
 * Stock Marko 6.4.4 refuses `<script async>`, `<script src="/x.js">` ("does not
 * support html attributes") and a placeholder in the body ("Unexpected content
 * in `<script>` tag"); MX compiled both, discarding the attribute and not
 * reading the body. Probed on the stock parser (positions 1-based line:column;
 * MX's columns are 0-based, one less):
 * `scratch/reports/probes/script-and-export-equals-7cfaa606/` and
 * `scratch/reports/script-tag-attrs-and-placeholder.md`.
 *
 * It also refuses the head forms stock refuses and MX read past: arguments,
 * params, a tag variable, a second value and a value next to a body. Probed on
 * the stock parser with `packages/stock-marko` (`stockMarkoCompile`), whose
 * positions are 0-based columns, as here.
 */
import { describe, expect, it } from "vitest";
import memberSyntax from "./fixtures/syntax/member-fixture.ts";
import { lowerSource } from "./ir-entry/index.ts";
import type { Dialect } from "./syntax-table.ts";

const CODE = "MX_INERT_TAG_SHAPE";

function lower(source: string, options: Record<string, unknown> = {}) {
  return lowerSource(source, "/f/t.mx", {
    tagRules: "html",
    structural: "pass",
    ...options,
  });
}

const attributeMessage = (name: string) =>
  `\`<script>\` does not support the \`${name}\` attribute: the tag is client code, not an html element, so the attribute would be silently discarded. For a native html \`<script>\` element use \`<html-script>\``;
const spreadMessage =
  "`<script>` does not support spread attributes: the tag is client code, not an html element, so a spread's keys would be silently discarded. For a native html `<script>` element use `<html-script>`";
const PLACEHOLDER =
  "A `<script>` body is JavaScript or TypeScript text, so a `${…}` placeholder in it is not supported. Use the value directly (`x`, not `${x}`), in a string through a template literal, or for a native html `<script>` element use `<html-script>`";

type Refusal = {
  message: string;
  /** 1-based line, 0-based column: the stock probe's column minus one. */
  line: number;
  column: number;
  end: { line: number; column: number };
};

/** `<div/>` is line 1, as in the stock probe. */
const page = (open: string, body = "console.log(1);") =>
  `<div/>\n${open}\n  ${body}\n</script>\n`;

const REFUSED: [string, string, Refusal][] = [
  [
    "async",
    page("<script async>"),
    {
      message: attributeMessage("async"),
      line: 2,
      column: 8,
      end: { line: 2, column: 13 },
    },
  ],
  [
    "src, with an empty body",
    '<div/>\n<script src="/x.js"></script>\n',
    {
      message: attributeMessage("src"),
      line: 2,
      column: 8,
      end: { line: 2, column: 19 },
    },
  ],
  [
    "type",
    page('<script type="module">'),
    {
      message: attributeMessage("type"),
      line: 2,
      column: 8,
      end: { line: 2, column: 21 },
    },
  ],
  [
    "defer",
    page("<script defer>"),
    {
      message: attributeMessage("defer"),
      line: 2,
      column: 8,
      end: { line: 2, column: 13 },
    },
  ],
  [
    "id",
    page('<script id="x">'),
    {
      message: attributeMessage("id"),
      line: 2,
      column: 8,
      end: { line: 2, column: 14 },
    },
  ],
  [
    "nonce",
    page('<script nonce="n">'),
    {
      message: attributeMessage("nonce"),
      line: 2,
      column: 8,
      end: { line: 2, column: 17 },
    },
  ],
  [
    "class",
    page('<script class="a">'),
    {
      message: attributeMessage("class"),
      line: 2,
      column: 8,
      end: { line: 2, column: 17 },
    },
  ],
  [
    "an attribute with a false value",
    page("<script async=false>"),
    {
      message: attributeMessage("async"),
      line: 2,
      column: 8,
      end: { line: 2, column: 19 },
    },
  ],
  [
    "the second attribute, after the tag's own value",
    "<div/>\n<script value=() => {} async>\n</script>\n",
    {
      message: attributeMessage("async"),
      line: 2,
      column: 23,
      end: { line: 2, column: 28 },
    },
  ],
  [
    "the first of two attributes",
    page("<script async defer>"),
    {
      message: attributeMessage("async"),
      line: 2,
      column: 8,
      end: { line: 2, column: 13 },
    },
  ],
  [
    "an attribute on its own line",
    "<div/>\n<script\n  async\n>\n  console.log(1);\n</script>\n",
    {
      message: attributeMessage("async"),
      line: 3,
      column: 2,
      end: { line: 3, column: 7 },
    },
  ],
  [
    "an attribute of a script nested in a tag",
    "<div>\n  <script async>\n    a();\n  </script>\n</div>\n",
    {
      message: attributeMessage("async"),
      line: 2,
      column: 10,
      end: { line: 2, column: 15 },
    },
  ],
  [
    "an attribute of a concise script",
    "div\nscript async -- a();\n",
    {
      message: attributeMessage("async"),
      line: 2,
      column: 7,
      end: { line: 2, column: 12 },
    },
  ],
  [
    "a placeholder in code",
    page("<script>", "const a = ${x};"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 12,
      end: { line: 3, column: 16 },
    },
  ],
  [
    "a placeholder in a double-quoted string",
    page("<script>", 'const a = "${x}";'),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 13,
      end: { line: 3, column: 17 },
    },
  ],
  [
    "a placeholder in a single-quoted string",
    page("<script>", "const a = '${x}';"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 13,
      end: { line: 3, column: 17 },
    },
  ],
  [
    "an unescaped placeholder",
    page("<script>", "const a = $!{x};"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 12,
      end: { line: 3, column: 17 },
    },
  ],
  [
    "a placeholder in a regular expression",
    page("<script>", "const a = /${x}/;"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 13,
      end: { line: 3, column: 17 },
    },
  ],
  [
    "a placeholder after a template literal",
    page("<script>", "const a = `${x}` + ${y};"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 21,
      end: { line: 3, column: 25 },
    },
  ],
  [
    "a placeholder after a template literal whose expression has braces",
    page("<script>", "const a = `${ {a:1}.a }` + ${y};"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 29,
      end: { line: 3, column: 33 },
    },
  ],
  [
    "a placeholder in a type position",
    page("<script>", "const a: string = ${x};"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 20,
      end: { line: 3, column: 24 },
    },
  ],
  [
    "a placeholder alone in the body",
    page("<script>", "${x}"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 2,
      end: { line: 3, column: 6 },
    },
  ],
  [
    "a placeholder in an html comment",
    page("<script>", "<!-- ${x} -->\n  const a = 1;"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 7,
      end: { line: 3, column: 11 },
    },
  ],
  [
    "the first of two placeholders",
    page("<script>", "const a = ${x}, b = ${y};"),
    {
      message: PLACEHOLDER,
      line: 3,
      column: 12,
      end: { line: 3, column: 16 },
    },
  ],
  [
    "a placeholder in a concise script",
    "div\nscript -- const a = ${x};\n",
    {
      message: PLACEHOLDER,
      line: 2,
      column: 20,
      end: { line: 2, column: 24 },
    },
  ],
  [
    "a placeholder on the second line of a concise script",
    "div\nscript\n  --\n  const a = 1;\n  const b = ${x};\n  --\n",
    {
      message: PLACEHOLDER,
      line: 5,
      column: 12,
      end: { line: 5, column: 16 },
    },
  ],
  [
    "a #id shorthand",
    page("<script#foo>"),
    {
      message: attributeMessage("#foo"),
      line: 2,
      column: 7,
      end: { line: 2, column: 11 },
    },
  ],
  [
    "a .class shorthand",
    page("<script.foo>"),
    {
      message: attributeMessage(".foo"),
      line: 2,
      column: 7,
      end: { line: 2, column: 11 },
    },
  ],
  [
    "a dynamic .class shorthand",
    page("<script.${c}>"),
    {
      message: attributeMessage(".${c}"),
      line: 2,
      column: 7,
      end: { line: 2, column: 12 },
    },
  ],
  [
    "a #id shorthand on a concise script",
    "div\nscript#foo -- a();\n",
    {
      message: attributeMessage("#foo"),
      line: 2,
      column: 6,
      end: { line: 2, column: 10 },
    },
  ],
  [
    "a method attribute that is not the default",
    "<div/>\n<script foo() { a() }/>\n",
    {
      message: attributeMessage("foo"),
      line: 2,
      column: 8,
      end: { line: 2, column: 21 },
    },
  ],
  [
    "an attribute with arguments",
    "<div/>\n<script foo(x)=1/>\n",
    {
      message: attributeMessage("foo"),
      line: 2,
      column: 8,
      end: { line: 2, column: 16 },
    },
  ],
  [
    "a bound value",
    "<div/>\n<script value:=x/>\n",
    {
      message: attributeMessage("value:="),
      line: 2,
      column: 8,
      end: { line: 2, column: 16 },
    },
  ],
  [
    "a bound default value",
    "<div/>\n<script:=x/>\n",
    {
      message: attributeMessage("value:="),
      line: 2,
      column: 7,
      end: { line: 2, column: 10 },
    },
  ],
  [
    "a value with a modifier",
    "<div/>\n<script value:no-update=() => a()/>\n",
    {
      message: attributeMessage("value:no-update"),
      line: 2,
      column: 8,
      end: { line: 2, column: 33 },
    },
  ],
  [
    "a spread",
    page("<script ...attrs>"),
    {
      message: spreadMessage,
      line: 2,
      column: 8,
      end: { line: 2, column: 16 },
    },
  ],
];

describe("a built-in <script> with an attribute or a placeholder is refused", () => {
  it.each(REFUSED)("%s", (_label, source, expected) => {
    const { ir, diagnostics } = lower(source);
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic).toMatchObject({
      code: CODE,
      message: expected.message,
      line: expected.line,
      column: expected.column,
      end: expected.end,
    });
    // The offset is the file's, counted from the source start.
    const lines = source.split("\n");
    const offset =
      lines.slice(0, expected.line - 1).reduce((n, l) => n + l.length + 1, 0) +
      expected.column;
    expect(diagnostic?.offset).toBe(offset);
  });

  it("names <html-script> as the fix", () => {
    for (const source of [
      page("<script async>"),
      page("<script>", "const a = ${x};"),
    ]) {
      expect(lower(source).diagnostics[0]?.message).toContain(
        "`<html-script>`",
      );
    }
  });

  it("reports an attribute and a placeholder of one <script> together", () => {
    const { diagnostics } = lower(page("<script async>", "const a = ${x};"));
    expect(diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      [CODE, 2, 8],
      [CODE, 3, 12],
    ]);
  });

  it("reports every <script> that is refused, with the other errors", () => {
    const { diagnostics } = lower(
      "<div/>\n<script async></script>\n<script>\nconst = 1;\n</script>\n<script src=x></script>\n<script>\nok();\n</script>",
    );
    expect(diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      [CODE, 2, 8],
      ["MX_INVALID_STATEMENT", 4, 6],
      [CODE, 6, 8],
    ]);
  });

  it("refuses a script inside a <for> and an <if>", () => {
    for (const source of [
      "<for|x| of=[1]>\n  <script async></script>\n</for>\n",
      "<if=true>\n  <script>\n    const a = ${1};\n  </script>\n</if>\n",
    ]) {
      expect(lower(source).diagnostics.map((d) => d.code)).toEqual([CODE]);
    }
  });
});

/** The rows stock 6.4.4 compiles. */
const ACCEPTED: [string, string][] = [
  ["a plain body", page("<script>")],
  ["no body", "<div/>\n<script></script>\n"],
  ["the tag's own value", "<div/>\n<script value=() => {}>\n</script>\n"],
  ["the tag's own value, self-closed", "<div/>\n<script value=() => {}/>\n"],
  ["the tag's default value", "<div/>\n<script=() => {}>\n</script>\n"],
  ["the tag's method form", "<div/>\n<script() { console.log(1) }/>\n"],
  ["a method named async", "<div/>\n<script async() { console.log(1) }/>\n"],
  ["a method on the value", "<div/>\n<script value() { console.log(1) }/>\n"],
  ["the value with arguments", "<div/>\n<script value(x)=1/>\n"],
  ["a template literal placeholder", page("<script>", "const a = `${x}`;")],
  ["nested template literals", page("<script>", "const a = `${`${x}`}`;")],
  [
    "a string inside a template literal expression",
    page("<script>", 'const a = `a ${ "${x}" }`;'),
  ],
  [
    "a placeholder in a line comment",
    page("<script>", "// ${x}\n  const a = 1;"),
  ],
  ["a placeholder in a block comment", page("<script>", "/* ${x} */")],
  [
    "a template literal in a concise script",
    "div\nscript -- const a = `${x}`;\n",
  ],
  [
    "<html-script> with attributes",
    '<div/>\n<html-script async src="/x.js"></html-script>\n',
  ],
  [
    "<html-script> with a placeholder",
    "<div/>\n<html-script>\n  const a = ${x};\n</html-script>\n",
  ],
];

describe("a built-in <script> in a shape stock accepts is not refused", () => {
  it.each(ACCEPTED)("%s", (_label, source) => {
    expect(lower(source).diagnostics.filter((d) => d.code === CODE)).toEqual(
      [],
    );
  });
});

describe("where `<script>` is not the built-in tag", () => {
  const ATTRIBUTE = '<div/>\n<script async src="/x.js">\n  a();\n</script>\n';
  const BODY = "<div/>\n<script>\n  const a = ${x};\n</script>\n";

  it("does not check a script under the `none` tag rules", () => {
    // `none` reads `<script>` as an ordinary tag: attributes and tags and
    // placeholders in its body are those of any tag.
    for (const source of [ATTRIBUTE, BODY]) {
      const { diagnostics } = lowerSource(source, "/f/t.mx", {
        tagRules: "none",
        structural: "pass",
      });
      expect(diagnostics.filter((d) => d.code === CODE)).toEqual([]);
    }
  });

  it("does not check a tag a caller registered under that name", () => {
    for (const source of [ATTRIBUTE, BODY]) {
      const { diagnostics } = lower(source, {
        customTags: { script: { attributes: {} } },
      });
      expect(diagnostics.filter((d) => d.code === CODE)).toEqual([]);
    }
  });
});

const DUPLICATE = "MX_DUPLICATE_VALUE_ATTRIBUTE";
const NATIVE = "For a native html `<script>` element use `<html-script>`";
const ARGUMENTS =
  "Tag does not support arguments. A `<script>` tag takes none: remove the `(…)`, and write the code as the body or the value as `value=…`";
const PARAMETERS =
  "Tag does not support parameters. A `<script>` tag takes none: remove the `|…|`";
const VARIABLE = `\`<script>\` does not support a tag variable reference. ${NATIVE}`;
const DUPLICATE_VALUE = "Invalid duplicate value attribute.";
const VALUE_AND_BODY = `${DUPLICATE_VALUE} A \`<script>\` body is its value: write the body or \`value=…\`, not both`;

type HeadRefusal = Refusal & { code: string };

/**
 * The head forms stock refuses. Stock's position is the first argument, the
 * first param, the variable, the second value, or the tag for a value next to
 * a body; its message is the sentence at the front of ours.
 */
const HEAD_FORMS: [string, string, HeadRefusal][] = [
  [
    "arguments",
    page("<script(x, y)>"),
    {
      code: CODE,
      message: ARGUMENTS,
      line: 2,
      column: 8,
      end: { line: 2, column: 12 },
    },
  ],
  [
    "arguments, self-closed",
    "<div/>\n<script(x)/>\n",
    {
      code: CODE,
      message: ARGUMENTS,
      line: 2,
      column: 8,
      end: { line: 2, column: 9 },
    },
  ],
  [
    "arguments on a concise script",
    "div\nscript(x) -- a();\n",
    {
      code: CODE,
      message: ARGUMENTS,
      line: 2,
      column: 7,
      end: { line: 2, column: 8 },
    },
  ],
  [
    "params",
    page("<script|x, y|>"),
    {
      code: CODE,
      message: PARAMETERS,
      line: 2,
      column: 8,
      end: { line: 2, column: 12 },
    },
  ],
  [
    "params on a concise script",
    "div\nscript|x| -- a();\n",
    {
      code: CODE,
      message: PARAMETERS,
      line: 2,
      column: 7,
      end: { line: 2, column: 8 },
    },
  ],
  [
    "a tag variable",
    page("<script/x>"),
    {
      code: CODE,
      message: VARIABLE,
      line: 2,
      column: 8,
      end: { line: 2, column: 9 },
    },
  ],
  [
    "a tag variable, self-closed",
    "<div/>\n<script/x/>\n",
    {
      code: CODE,
      message: VARIABLE,
      line: 2,
      column: 8,
      end: { line: 2, column: 9 },
    },
  ],
  [
    "a destructured tag variable",
    "<div/>\n<script/{ a, b }/>\n",
    {
      code: CODE,
      message: VARIABLE,
      line: 2,
      column: 8,
      end: { line: 2, column: 16 },
    },
  ],
  [
    "a tag variable on a concise script",
    "div\nscript/x -- a();\n",
    {
      code: CODE,
      message: VARIABLE,
      line: 2,
      column: 7,
      end: { line: 2, column: 8 },
    },
  ],
  [
    "a value and a body",
    page("<script value=() => a()>"),
    {
      code: DUPLICATE,
      message: VALUE_AND_BODY,
      line: 2,
      column: 0,
      end: { line: 2, column: 7 },
    },
  ],
  [
    "the default value and a body",
    page("<script=x>"),
    {
      code: DUPLICATE,
      message: VALUE_AND_BODY,
      line: 2,
      column: 0,
      end: { line: 2, column: 7 },
    },
  ],
  [
    "a method value and a body",
    page("<script() { a() }>"),
    {
      code: DUPLICATE,
      message: VALUE_AND_BODY,
      line: 2,
      column: 0,
      end: { line: 2, column: 7 },
    },
  ],
  [
    "a value and a comment as the body",
    "<div/>\n<script value=x>\n  // c\n</script>\n",
    {
      code: DUPLICATE,
      message: VALUE_AND_BODY,
      line: 2,
      column: 0,
      end: { line: 2, column: 7 },
    },
  ],
  [
    "a value and a body on a concise script",
    "div\nscript value=x -- a();\n",
    {
      code: DUPLICATE,
      message: VALUE_AND_BODY,
      line: 2,
      column: 0,
      end: { line: 2, column: 6 },
    },
  ],
  [
    "a value and a concise block body",
    "div\nscript value=x\n  --\n  a();\n  --\n",
    {
      code: DUPLICATE,
      message: VALUE_AND_BODY,
      line: 2,
      column: 0,
      end: { line: 2, column: 6 },
    },
  ],
  [
    "two values",
    "<div/>\n<script value=x value=y/>\n",
    {
      code: DUPLICATE,
      message: DUPLICATE_VALUE,
      line: 2,
      column: 16,
      end: { line: 2, column: 23 },
    },
  ],
  [
    "three values, the second one is reported",
    "<div/>\n<script value=1 value=2 value=3/>\n",
    {
      code: DUPLICATE,
      message: DUPLICATE_VALUE,
      line: 2,
      column: 16,
      end: { line: 2, column: 23 },
    },
  ],
  [
    "the default value and a named one",
    "<div/>\n<script=x value=y/>\n",
    {
      code: DUPLICATE,
      message: DUPLICATE_VALUE,
      line: 2,
      column: 10,
      end: { line: 2, column: 17 },
    },
  ],
  [
    "a method value and a named one",
    "<div/>\n<script() { a() } value=x/>\n",
    {
      code: DUPLICATE,
      message: DUPLICATE_VALUE,
      line: 2,
      column: 18,
      end: { line: 2, column: 25 },
    },
  ],
  [
    "two values on a concise script",
    "div\nscript value=x value=y\n",
    {
      code: DUPLICATE,
      message: DUPLICATE_VALUE,
      line: 2,
      column: 15,
      end: { line: 2, column: 22 },
    },
  ],
  // Which one stock reports when a tag has several: arguments, then params,
  // then the variable, then the attributes and values as written, then a body.
  [
    "arguments before params",
    page("<script(z)|y|>"),
    {
      code: CODE,
      message: ARGUMENTS,
      line: 2,
      column: 8,
      end: { line: 2, column: 9 },
    },
  ],
  [
    "params before the variable",
    page("<script/x|y|>"),
    {
      code: CODE,
      message: PARAMETERS,
      line: 2,
      column: 10,
      end: { line: 2, column: 11 },
    },
  ],
  [
    "the variable before a second value",
    page("<script/x value=1 value=2>"),
    {
      code: CODE,
      message: VARIABLE,
      line: 2,
      column: 8,
      end: { line: 2, column: 9 },
    },
  ],
  [
    "a second value before an attribute written after it",
    "<div/>\n<script value=1 value=2 async/>\n",
    {
      code: DUPLICATE,
      message: DUPLICATE_VALUE,
      line: 2,
      column: 16,
      end: { line: 2, column: 23 },
    },
  ],
  [
    "an attribute before a second value written after it",
    "<div/>\n<script async value=1 value=2/>\n",
    {
      code: CODE,
      message: attributeMessage("async"),
      line: 2,
      column: 8,
      end: { line: 2, column: 13 },
    },
  ],
  [
    "an attribute before a body next to a value",
    page("<script value=1 async>"),
    {
      code: CODE,
      message: attributeMessage("async"),
      line: 2,
      column: 16,
      end: { line: 2, column: 21 },
    },
  ],
  // The earliest shorthand, not the one the parser rewrites first.
  [
    "the id of #a.b, written first",
    page("<script#a.b>"),
    {
      code: CODE,
      message: attributeMessage("#a"),
      line: 2,
      column: 7,
      end: { line: 2, column: 9 },
    },
  ],
  [
    "the id of a concise script#a.b",
    "div\nscript#a.b -- a();\n",
    {
      code: CODE,
      message: attributeMessage("#a"),
      line: 2,
      column: 6,
      end: { line: 2, column: 8 },
    },
  ],
  [
    "the class of .b#a, written first",
    page("<script.b#a>"),
    {
      code: CODE,
      message: attributeMessage(".b"),
      line: 2,
      column: 7,
      end: { line: 2, column: 9 },
    },
  ],
];

describe("a built-in <script> with a head form stock refuses", () => {
  it.each(HEAD_FORMS)("%s", (_label, source, expected) => {
    const { ir, diagnostics } = lower(source);
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: expected.code,
      message: expected.message,
      line: expected.line,
      column: expected.column,
      end: expected.end,
    });
  });

  it("reports a head form and a placeholder of one <script> together", () => {
    const { diagnostics } = lower(page("<script/x>", "a(${x});"));
    expect(diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      [CODE, 2, 8],
      [CODE, 3, 4],
    ]);
  });

  it("reports a placeholder, not a value next to a body, when the body has one", () => {
    const { diagnostics } = lower(page("<script value=x>", "a(${x});"));
    expect(diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      [CODE, 3, 4],
    ]);
  });

  it("records every refused <script> and keeps lowering", () => {
    const { diagnostics } = lower(
      "<div/>\n<script/x></script>\n<script|y|></script>\n<script value=1 value=2/>\n<script>\nok();\n</script>\n",
    );
    expect(diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      [CODE, 2, 8],
      [CODE, 3, 8],
      [DUPLICATE, 4, 16],
    ]);
  });

  it("refuses the head forms of a script inside a <for> and an <if>", () => {
    for (const source of [
      "<for|x| of=[1]>\n  <script/y></script>\n</for>\n",
      "<if=true>\n  <script value=1>\n    a();\n  </script>\n</if>\n",
    ]) {
      expect(lower(source).diagnostics).toHaveLength(1);
    }
  });

  it("names the tag as the dialect spells it", () => {
    const dialect = {
      ...memberSyntax,
      name: "member",
      messageVocabulary: {
        attribute: { one: "option", many: "options" },
        file: "Kit file",
        tree: "Kit file",
        formatTag: ({ name }: { name: string }) => name,
      },
    } as Dialect;
    const [variable] = lowerSource("div\nscript/x -- a();\n", "/f/t.mx", {
      tagRules: "html",
      structural: "pass",
      dialect,
    }).diagnostics;
    expect(variable?.message).toBe(
      "`script` does not support a tag variable reference. For a native html `<script>` element use `html-script`",
    );
    const [body] = lowerSource("div\nscript value=x -- a();\n", "/f/t.mx", {
      tagRules: "html",
      structural: "pass",
      dialect,
    }).diagnostics;
    expect(body?.message).toBe(
      "Invalid duplicate value option. A `script` body is its value: write the body or `value=…`, not both",
    );
  });
});

describe("a built-in <script> with a value or a body, not both, is not refused", () => {
  it.each([
    ["a body", page("<script>")],
    ["a value", "<div/>\n<script value=x/>\n"],
    ["a value and an empty body", "<div/>\n<script value=x></script>\n"],
    ["a value and a blank body", "<div/>\n<script value=x>\n  \n</script>\n"],
    ["a method and no body", "<div/>\n<script() { a() }/>\n"],
    ["empty arguments", page("<script()>")],
    ["empty params", page("<script||>")],
    ["a concise value", "div\nscript value=x\n"],
  ])("%s", (_label, source) => {
    expect(lower(source).diagnostics).toEqual([]);
  });
});
