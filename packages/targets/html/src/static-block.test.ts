// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * `static { … }` is its statements at module scope with the braces gone, as
 * stock Marko 6.4.4 reads it (probed with `packages/stock-marko`): the
 * bindings the block declares are the module's, so the template reads them.
 * Only a body that is exactly one block unwraps; the `server { … }` block
 * hoists the same way. The expected module code is what the block's text
 * says between its braces, trimmed and otherwise verbatim.
 */
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/** The hoisted module code: what sits between the runtime import and `export interface Input`. */
function hoisted(source: string): string {
  const { code } = compile(source, "/f/t.mx");
  const from = code.indexOf("\n", code.indexOf("@mxlang/target-html")) + 1;
  return code.slice(from, code.indexOf("export interface Input")).trim();
}

function fail(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compile(source, "/f/t.mx");
  } catch (error) {
    return error as { message: string; line: number; column: number };
  }
  throw new Error("expected a compile error");
}

const TEMPLATE = "\n<div>${q}</div>\n";

describe("html: a `static { … }` block hoists its statements, not the block", () => {
  it.each([
    ["one line", "static { let q = 1; }", "let q = 1;"],
    ["no trailing semicolon", "static { let q = 1 }", "let q = 1"],
    ["`static {` then a newline", "static {\n  let q = 1;\n}", "let q = 1;"],
    [
      "several statements",
      "static {\n  let q = 1;\n  const r = 2;\n}",
      "let q = 1;\n  const r = 2;",
    ],
    [
      "a nested block stays a block",
      "static {\n  let q = 1;\n  {\n    let z = 2;\n  }\n}",
      "let q = 1;\n  {\n    let z = 2;\n  }",
    ],
    [
      "comments inside the braces",
      "static {\n  // lead\n  let q = 1; /* mid */\n  // trail\n}",
      "// lead\n  let q = 1; /* mid */\n  // trail",
    ],
    [
      "a function declaration",
      "static {\n  function q() { return 1 }\n}",
      "function q() { return 1 }",
    ],
    ["an expression statement", "static { console.log(1) }", "console.log(1)"],
    ["an object literal statement", "static { ({ a: 1 }) }", "({ a: 1 })"],
    ["a labelled block", "static { a: { break a } }", "a: { break a }"],
    [
      "a comment after the closing brace goes with the braces",
      "static { let q = 1 } // after",
      "let q = 1",
    ],
    [
      "a semicolon after the closing brace: the body is a block and an empty statement",
      "static { let q = 1 };",
      "{ let q = 1 };",
    ],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("an empty block hoists nothing", () => {
    expect(hoisted("static {}\n<div>x</div>\n")).toBe("");
    expect(hoisted("static {\n}\n<div>x</div>\n")).toBe("");
    expect(hoisted("static { /* only a comment */ }\n<div>x</div>\n")).toBe("");
  });

  it("two blocks in one file hoist in source order", () => {
    expect(
      hoisted(
        "static { let a = 1 }\nstatic { let b = 2 }\n<div>${a}${b}</div>\n",
      ),
    ).toBe("let a = 1\nlet b = 2");
  });

  it("unwraps one level only", () => {
    expect(hoisted("static {{ let z = 1 }}\n<div>x</div>\n")).toBe(
      "{ let z = 1 }",
    );
  });

  it("a body of more than one block keeps its blocks, as Marko does", () => {
    expect(hoisted("static { a } { b }\n<div>x</div>\n")).toBe("{ a } { b }");
    expect(hoisted("static { let a = 1; } let b = 2\n<div>x</div>\n")).toBe(
      "{ let a = 1; } let b = 2",
    );
  });

  it("the non-block form is unchanged", () => {
    expect(hoisted(`static let q = 1${TEMPLATE}`)).toBe("let q = 1");
    expect(
      hoisted("static function q() { return 1 }\n<div>${q()}</div>\n"),
    ).toBe("function q() { return 1 }");
    expect(hoisted("static ({ a: 1 })\n<div>x</div>\n")).toBe("({ a: 1 })");
  });

  it("the template reads a binding the block declares", () => {
    const { code } = compile(`static { const q = 1 }${TEMPLATE}`, "/f/t.mx");
    expect(code).toContain("const q = 1\n");
    expect(code).toContain("__mxOut.write(__mxEscape(__mxTextOf(q)));");
    expect(code).not.toContain("{ const q = 1 }");
    // The binding is declared before the render function that reads it.
    expect(code.indexOf("const q = 1")).toBeLessThan(
      code.indexOf("function __mxRender"),
    );
  });

  it("a syntax error inside the block keeps its line and column", () => {
    const error = fail("static {\n  let q = ;\n}\n<div>x</div>\n");
    expect([error.line, error.column]).toEqual([2, 10]);
  });
});

describe("html: a `server { … }` block hoists its statements, not the block", () => {
  it.each([
    ["one line", "server { let q = 1 }", "let q = 1"],
    [
      "several lines",
      "server {\n  let q = 1\n  q += 1\n}",
      "let q = 1\n  q += 1",
    ],
    ["a body of more than one block", "server { a } { b }", "{ a } { b }"],
    ["the non-block form", "server let q = 1", "let q = 1"],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}${TEMPLATE}`)).toBe(expected);
  });

  it("an empty block hoists nothing", () => {
    expect(hoisted("server {}\n<div>x</div>\n")).toBe("");
  });

  it("the template reads a binding the block declares", () => {
    const { code } = compile(`server { const q = 1 }${TEMPLATE}`, "/f/t.mx");
    expect(code).not.toContain("{ const q = 1 }");
    expect(code.indexOf("const q = 1")).toBeLessThan(
      code.indexOf("function __mxRender"),
    );
  });
});

describe("html: the render-only name check reads an unwrapped block as module code", () => {
  it("a statement of the block that names `input` is still refused, at the name", () => {
    const error = fail("static {\n  const a = input.x;\n}\n<div>x</div>\n");
    expect(error.message).toContain(
      "`input` exists only while the template renders",
    );
    expect([error.line, error.column]).toEqual([2, 12]);
  });

  it("a block declaring the spelling of a top-level tag variable is still refused, at the declaration", () => {
    const error = fail(
      "<let/count=0/>\nstatic { const count = 1 }\n<div>${count}</div>\n",
    );
    expect(error.message).toContain(
      "`count` is a tag variable, which exists only while the template renders",
    );
    expect([error.line, error.column]).toEqual([2, 15]);
  });

  it("the same refusal holds when a comment follows the closing brace", () => {
    const error = fail(
      "<let/count=0/>\nstatic { const count = 1 } // c\n<div>${count}</div>\n",
    );
    expect([error.line, error.column]).toEqual([2, 15]);
  });

  it("a template read of a binding the block declares is not an error", () => {
    expect(() =>
      compile("static { const q = 1 }\n<div>${q}</div>\n", "/f/t.mx"),
    ).not.toThrow();
  });

  it("a template read of a block binding is fine beside a nested tag variable of another name", () => {
    expect(() =>
      compile(
        "static { const base = 1 }\n<div><let/count=base/>${count}${base}</div>\n",
        "/f/t.mx",
      ),
    ).not.toThrow();
  });

  it("a later statement may read a binding an earlier block declares, though a nested tag declares the same spelling", () => {
    expect(() =>
      compile(
        "static { const base = 1 }\nstatic const n = base + 1\n<div><let/base=2/>${n}${base}</div>\n",
        "/f/t.mx",
      ),
    ).not.toThrow();
  });
});
