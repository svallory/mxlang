// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A `<script>` body must parse.
 *
 * Stock Marko 6.4.4 reads a `<script>` body as the statements of a module, in
 * TypeScript, and refuses one that does not parse at Babel's error. MX read the
 * text for its analyses only, skipped a body that failed to parse, and emitted
 * none of it on html, so a decorator or a syntax error compiled silently, and
 * the stale-read check (`MX_STALE_DERIVED_READ`) was switched off for that
 * body without a word. Probes (stock 6.4.4, positions 1-based line:column):
 * `scratch/reports/probes/script-body-syntax-stock-6.4.4.txt` and
 * `script-body-syntax-extra-stock-6.4.4.txt`.
 */
import { describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";

const CODE = "MX_INVALID_STATEMENT";

const DECORATOR =
  "Decorators are not read inside a `<script>` body: its text is TypeScript without decorator syntax. Move the decorated class to a `.ts` module and import it, or apply the decorator as a plain function call";
const IMPORT_EXPORT =
  "An `import` or `export` in a `<script>` body must be one of the body's own statements, not inside a block, an `if` or a function; move it out to the top of the `<script>` body.";
const ASSERT =
  'Import attributes are written with `with`, not `assert`: `import j from "./x.json" with { type: "json" }`';
const IMPORT_EQUALS =
  '`import x = require(...)` is a CommonJS form and is not read in a `<script>` body. Write `import x from "..."`';
const EXPORT_EQUALS =
  "`export = value` is a CommonJS form and is not read in a `<script>` body. Write `export default value`";
const JSX =
  "JSX is not read in a `<script>` body: its text is TypeScript. Write the markup as a tag in the template, or in a `<define>`";
const PIPELINE =
  "This syntax (the `pipelineOperator` proposal) is not read in a `<script>` body: its text is TypeScript, and a proposal that is not part of the language yet is not accepted. Write it with standard syntax";

function lower(source: string) {
  return lowerSource(source, "/f/t.mx", {
    tagRules: "html",
    structural: "pass",
  });
}

/** Each source starts with `<div/>` on line 1 and the body on line 3, as the stock probe's. */
const page = (body: string, open = "<script>") =>
  `<div/>\n${open}\n${body}\n</script>`;

type Refusal = {
  message: string;
  /** 1-based line, 0-based column of the start; the stock probe's column minus one. */
  line: number;
  column: number;
  end: { line: number; column: number };
};

const REFUSED: [string, string, Refusal][] = [
  [
    "a decorator",
    page("@d class C {}"),
    {
      message: DECORATOR,
      line: 3,
      column: 0,
      end: { line: 3, column: 2 },
    },
  ],
  [
    "a decorator on a member",
    page("class C { @d m() {} }"),
    {
      message: DECORATOR,
      line: 3,
      column: 10,
      end: { line: 3, column: 12 },
    },
  ],
  [
    "a syntax error",
    page("const = 1;"),
    {
      message: "Unexpected token",
      line: 3,
      column: 6,
      end: { line: 3, column: 6 },
    },
  ],
  [
    "an unclosed brace",
    page("if (x) {"),
    {
      message: "Unexpected token",
      line: 4,
      column: 0,
      end: { line: 4, column: 0 },
    },
  ],
  [
    "JSX",
    page("const e = <b/>;"),
    // Stock reports Babel's own position, the `/` (3:13); the `<` is where the
    // markup starts, which is where the message points.
    { message: JSX, line: 3, column: 10, end: { line: 3, column: 10 } },
  ],
  [
    "the pipeline operator",
    page("const v = a |> b;"),
    {
      message: PIPELINE,
      line: 3,
      column: 12,
      end: { line: 3, column: 12 },
    },
  ],
  [
    "an HTML comment",
    page("<!-- x -->"),
    {
      message: "Unexpected token",
      line: 3,
      column: 1,
      end: { line: 3, column: 1 },
    },
  ],
  [
    "a syntax error in a module script",
    page("const = 1;", '<script type="module">'),
    {
      message: "Unexpected token",
      line: 3,
      column: 6,
      end: { line: 3, column: 6 },
    },
  ],
  [
    "an import attribute written with assert",
    page('import j from "./x.json" assert { type: "json" };'),
    { message: ASSERT, line: 3, column: 25, end: { line: 3, column: 25 } },
  ],
  [
    "import x = require()",
    page('import x = require("y");'),
    {
      message: IMPORT_EQUALS,
      line: 3,
      column: 0,
      end: { line: 3, column: 24 },
    },
  ],
  [
    "export =",
    page("export = x;"),
    {
      message: EXPORT_EQUALS,
      line: 3,
      column: 0,
      end: { line: 3, column: 11 },
    },
  ],
  [
    "new.target",
    page("new.target;"),
    {
      message:
        "`new.target` can only be used in functions or class properties.",
      line: 3,
      column: 0,
      end: { line: 3, column: 0 },
    },
  ],
  [
    "super() outside a constructor",
    page("super();"),
    {
      message:
        "`super()` is only valid inside a class constructor of a subclass. Maybe a typo in the method name ('constructor') or not extending another class?",
      line: 3,
      column: 0,
      end: { line: 3, column: 0 },
    },
  ],
  [
    "super.x outside a method",
    page("super.x;"),
    {
      message: "'super' is only allowed in object methods and classes.",
      line: 3,
      column: 0,
      end: { line: 3, column: 0 },
    },
  ],
  [
    "an import inside a block",
    page('if (x) { import a from "b"; }'),
    {
      message: IMPORT_EXPORT,
      line: 3,
      column: 9,
      end: { line: 3, column: 9 },
    },
  ],
  [
    "an export inside a function",
    page("function f() { export const a = 1; }"),
    {
      message: IMPORT_EXPORT,
      line: 3,
      column: 15,
      end: { line: 3, column: 15 },
    },
  ],
  [
    "a JSON body (it is read as JavaScript)",
    page('{"a": 1}', '<script type="application/json">'),
    {
      message: "Missing semicolon.",
      line: 3,
      column: 4,
      end: { line: 3, column: 4 },
    },
  ],
];

describe("a <script> body that does not parse is refused", () => {
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

  it("never tells the user to enable a parser plugin", () => {
    for (const body of [
      "@d class C {}",
      "const v = a |> b;",
      'import j from "./x.json" assert { type: "json" };',
    ]) {
      const [diagnostic] = lower(page(body)).diagnostics;
      expect(diagnostic?.message).not.toMatch(/plugin|experimental syntax/i);
    }
  });
});

/** The rows stock 6.4.4 compiles: a body is a module-like function body in TypeScript. */
const ACCEPTED: [string, string][] = [
  ["an import", 'import x from "./x";'],
  ["an export", "export const y = 1;"],
  ["a top-level return", "return 1;"],
  ["a top-level await", 'await fetch("/x");'],
  ["a type annotation", "const n: number = 1;"],
  ["an enum", "enum E { A }"],
  ["satisfies", "const a = {} satisfies object;"],
  ["an angle assertion", "const a = <any>1;"],
  [
    "a namespace and a declare",
    "declare const x: number; namespace N { export const a = 1 }",
  ],
  ["class fields", "class C { x = 1; static y = 2 }"],
  ["a template literal", "const s = `a`;"],
  ["an import alias", "namespace B { export const C = 1 } import a = B.C;"],
  ["a closing-tag-like string", 'const s = "</scr" + "ipt>";'],
  [
    "object rest and spread",
    "const { a, ...rest } = o; const b = { ...rest };",
  ],
];

describe("a <script> body that parses is accepted", () => {
  it.each(ACCEPTED)("%s", (_label, body) => {
    expect(lower(page(body)).diagnostics).toEqual([]);
  });

  it("accepts an empty body", () => {
    expect(lower("<div/>\n<script></script>").diagnostics).toEqual([]);
  });

  it("leaves a body with a ${…} placeholder unread (it is not one text run)", () => {
    // Stock refuses it as unexpected content; that is the tag's shape rule, not
    // a parse of the text, and MX does not read the pieces.
    expect(
      lower("<div/>\n<script>\nconst a = ${1};\n</script>").diagnostics,
    ).toEqual([]);
  });
});

describe("the stale-read check runs on a body that parses (review of #568, L4)", () => {
  const DERIVED =
    "<let/items=[1]/> <const/total=items.length/> <div>${total}</div>";

  it("reports the stale read in a body that parses", () => {
    const { diagnostics } = lower(
      `${DERIVED} <script> items = []; class C {}; console.log(total) </script>`,
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["MX_STALE_DERIVED_READ"]);
  });

  it("refuses the body that does not parse, instead of skipping the check", () => {
    const { diagnostics } = lower(
      `${DERIVED} <script> items = []; @d class C {}; console.log(total) </script>`,
    );
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      [CODE, DECORATOR],
    ]);
  });

  it("reports the binding write check on a body that parses", () => {
    const { diagnostics } = lower(
      "<for|x| of=[1]><script>\nx = 2;\n</script></for>",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).not.toBe(CODE);
  });
});

describe("the error is placed in the file", () => {
  it("in a script nested in a tag, indented", () => {
    const { diagnostics } = lower(
      "<let/x=1/>\n<if=x>\n  <div>\n    <script>\n      const = 1;\n    </script>\n  </div>\n</if>",
    );
    expect(diagnostics[0]).toMatchObject({ code: CODE, line: 5, column: 12 });
  });

  it("in a script inside a <for>", () => {
    const { diagnostics } = lower(
      "<for|x| of=[1]>\n<script>\nconst = 1;\n</script>\n</for>",
    );
    expect(diagnostics[0]).toMatchObject({ code: CODE, line: 3, column: 6 });
  });

  it("when the body starts on the tag's own line", () => {
    const { diagnostics } = lower("<div/><script>const = 1;</script>");
    expect(diagnostics[0]).toMatchObject({ code: CODE, line: 1, column: 20 });
    expect(diagnostics[0]?.offset).toBe(20);
  });

  it("with CRLF line endings", () => {
    const source = "<div/>\r\n<script>\r\n@d class C {}\r\n</script>";
    const { diagnostics } = lower(source);
    expect(diagnostics[0]).toMatchObject({
      code: CODE,
      line: 3,
      column: 0,
      offset: source.indexOf("@d"),
      end: { line: 3, column: 2, offset: source.indexOf("@d") + 2 },
    });
    const syntax = lower("<div/>\r\n<script>\r\nconst = 1;\r\n</script>");
    expect(syntax.diagnostics[0]).toMatchObject({
      code: CODE,
      line: 3,
      column: 6,
    });
  });

  it("on the second line of a multi-line body", () => {
    const { diagnostics } = lower(page("const a = 1;\nconst b = ;"));
    expect(diagnostics[0]).toMatchObject({ code: CODE, line: 4, column: 10 });
  });

  it("after a multi-byte character in the body", () => {
    const { diagnostics } = lower(page("const s = '😀'; const = 1;"));
    expect(diagnostics[0]).toMatchObject({ code: CODE, line: 3, column: 22 });
  });
});

describe("a concise-mode script body", () => {
  const concise = (...lines: string[]) =>
    `<div/>\nscript\n${lines.map((l) => `  ${l}`).join("\n")}\n`;

  it("is checked across its lines, at the file's position", () => {
    const { diagnostics } = lower(
      concise("--", "const a = 1;", "const = 1;", "--"),
    );
    // `const = 1;` is on line 5, after two spaces of indentation.
    expect(diagnostics[0]).toMatchObject({
      code: CODE,
      message: "Unexpected token",
      line: 5,
      column: 8,
    });
  });

  it("is checked across two -- blocks", () => {
    const { diagnostics } = lower(
      concise("--", "const a = 1;", "--", "-- const = 1;"),
    );
    expect(diagnostics[0]).toMatchObject({
      code: CODE,
      line: 6,
      column: 11,
    });
  });

  it("refuses a decorator on the second line", () => {
    const { diagnostics } = lower(
      concise("--", "const a = 1;", "@d class C {}", "--"),
    );
    expect(diagnostics[0]).toMatchObject({
      code: CODE,
      message: DECORATOR,
      line: 5,
      column: 2,
      end: { line: 5, column: 4 },
    });
  });

  it("accepts a body that parses", () => {
    expect(
      lower(concise("--", "const a = 1;", "const b = a + 1;", "--"))
        .diagnostics,
    ).toEqual([]);
    expect(
      lower(concise("--", "const a = 1;", "--", "-- const b = 2;")).diagnostics,
    ).toEqual([]);
  });

  it("reports a stale read in its lines", () => {
    const { diagnostics } = lower(
      "<let/items=[1]/>\n<const/total=items.length/>\n<div>${total}</div>\nscript\n  --\n  items = [];\n  console.log(total);\n  --\n",
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["MX_STALE_DERIVED_READ"]);
  });
});

describe("where `<script>` is not a raw-text tag", () => {
  it("does not check the body under the `none` tag rules", () => {
    // `none` reads `<script>` as an ordinary tag: its body is tags and
    // whitespace-normalized text, not script text.
    const { diagnostics } = lowerSource(
      "<div/>\n<script>\nconst = 1;\n</script>",
      "/f/t.mx",
      { tagRules: "none", structural: "pass" },
    );
    expect(diagnostics).toEqual([]);
  });

  it("does not check the body of a registered tag named script", () => {
    const { diagnostics } = lowerSource(
      "<div/>\n<script>\nconst = 1;\n</script>",
      "/f/t.mx",
      {
        tagRules: "html",
        structural: "pass",
        customTags: { script: { attributes: {} } },
      },
    );
    expect(diagnostics.map((d) => d.code)).not.toContain(CODE);
  });
});

describe("more than one error", () => {
  it("reports every <script> that does not parse, with the other errors", () => {
    const { diagnostics } = lower(
      "<div/>\n<script>\nconst = 1;\n</script>\n<script>\n@d class C {}\n</script>\n<script>\nok();\n</script>",
    );
    expect(diagnostics.map((d) => [d.code, d.line, d.column])).toEqual([
      [CODE, 3, 6],
      [CODE, 6, 0],
    ]);
  });
});
