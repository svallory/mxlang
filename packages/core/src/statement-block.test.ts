// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * A module body that is exactly one block statement unwraps to the text
 * between its braces, as Marko reads `static { … }`; any other body stays as
 * written.
 */
import { describe, expect, it } from "vitest";
import { statementBlock, unwrapStatementBlock } from "./statement-block.ts";

describe("unwrapStatementBlock", () => {
  it.each([
    ["{ let q = 1 }", "let q = 1"],
    ["{let q = 1}", "let q = 1"],
    ["{\n  let q = 1;\n  let r = 2;\n}", "let q = 1;\n  let r = 2;"],
    ["{ {} }", "{}"],
    ["{{ let z = 1 }}", "{ let z = 1 }"],
    ["{ a: { break a } }", "a: { break a }"],
    ["{ ({ a: 1 }) }", "({ a: 1 })"],
    ["{ // lead\n  x() }", "// lead\n  x()"],
    ["{ x() } // after", "x()"],
    ["  { x() }  ", "x()"],
    ["{ return 1 }", "return 1"],
    ['{ const s = "}" }', 'const s = "}"'],
    ["{ const t = `${'}'}` }", "const t = `${'}'}`"],
    ["{ const f = <T,>(x: T): T => x }", "const f = <T,>(x: T): T => x"],
  ])("unwraps %j", (code, expected) => {
    expect(unwrapStatementBlock(code)).toBe(expected);
  });

  it.each([
    ["{}"],
    ["{ }"],
    ["{\n}"],
    ["{ /* only a comment */ }"],
    ["{ // only a comment\n}"],
  ])("an empty block, %j, unwraps to nothing", (code) => {
    expect(unwrapStatementBlock(code)).toBe("");
  });

  it.each([
    ["let q = 1"],
    ["function f() { return 1 }"],
    ["({ a: 1 })"],
    ["{ a } { b }"],
    ["{ a } let b = 1"],
    ["{ a };"],
    ["let q = {}"],
    ["{ let q = ; }"],
    [""],
  ])("%j is not a block: it stays as written", (code) => {
    expect(statementBlock(code)).toBeUndefined();
    expect(unwrapStatementBlock(code)).toBe(code);
  });

  it("reports where the braces are", () => {
    expect(statementBlock("  { x() }  ")).toEqual({
      open: 2,
      close: 8,
      empty: false,
    });
  });
});
