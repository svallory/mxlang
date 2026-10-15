// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * `static { … }` hoists its statements with the braces gone, as stock Marko
 * 6.4.4 does, so the template reads the bindings the block declares. React
 * and Hono lower through this emitter.
 */
import { describe, expect, it } from "vitest";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

const out = (source: string): string => compilePreactMx(source, "/f/t.mx").code;

/** The module code before the text helper and `export interface Input`, after the pragma line. */
function hoisted(source: string): string {
  const code = out(source);
  const end = [
    code.indexOf("const __mxRenderable"),
    code.indexOf("export interface Input"),
  ].filter((index) => index >= 0);
  return code.slice(code.indexOf("*/") + 2, Math.min(...end)).trim();
}

describe("preact: a `static { … }` block hoists its statements, not the block", () => {
  it.each([
    ["one line", "static { let q = 1; }", "let q = 1;"],
    ["`static {` then a newline", "static {\n  let q = 1;\n}", "let q = 1;"],
    [
      "several statements and a comment",
      "static {\n  // lead\n  let q = 1;\n  const r = 2;\n}",
      "// lead\n  let q = 1;\n  const r = 2;",
    ],
    [
      "a nested block stays a block",
      "static {\n  let q = 1;\n  {\n    let z = 2;\n  }\n}",
      "let q = 1;\n  {\n    let z = 2;\n  }",
    ],
    [
      "a function declaration",
      "static { function q() { return 1 } }",
      "function q() { return 1 }",
    ],
    ["a body of more than one block", "static { a } { b }", "{ a } { b }"],
    ["the non-block form", "static let q = 1", "let q = 1"],
  ])("%s", (_name, statement, expected) => {
    expect(hoisted(`${statement}\n<div>\${q}</div>\n`)).toBe(expected);
  });

  it("an empty block hoists nothing", () => {
    expect(hoisted("static {}\n<div>x</div>\n")).toBe("");
  });

  it("the component reads a binding the block declares, declared above it", () => {
    const code = out("static { const q = 1 }\n<div>${q}</div>\n");
    expect(code).toContain("<div>{__mxRenderable(q)}</div>");
    expect(code).not.toContain("{ const q = 1 }");
    expect(code.indexOf("const q = 1")).toBeLessThan(
      code.indexOf("export default function"),
    );
  });

  it("a syntax error inside the block keeps its line and column", () => {
    expect(() => out("static {\n  let q = ;\n}\n<div>x</div>\n")).toThrow(
      expect.objectContaining({ line: 2, column: 10 }),
    );
  });

  it("a statement of the block that names `input` is refused at the name", () => {
    expect(() =>
      out("static {\n  const a = input.x;\n}\n<div>x</div>\n"),
    ).toThrow(
      expect.objectContaining({
        line: 2,
        column: 12,
        message: expect.stringContaining("`input` exists only while"),
      }),
    );
  });
});

describe("preact: an empty `static` block is still a module-level statement", () => {
  it.each([
    "static {}",
    "static { /* only a comment */ }",
    "static { let q = 1 }",
  ])("%s is refused in a region, like any other", (statement) => {
    expect(() =>
      compilePreactRegion(`${statement}\n<div/>`, {
        filename: "/f/t.preact.mx",
      }),
    ).toThrow(/module-level MX statements cannot appear inside a `.preact.mx`/);
  });
});
