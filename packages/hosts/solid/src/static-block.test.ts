// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/** `static { … }` hoists its statements with the braces gone, as stock Marko 6.4.4 does. */
import { describe, expect, it } from "vitest";
import { compileSolidUnit } from "./index.ts";

const out = (source: string): string =>
  compileSolidUnit(source, { filename: "/f/t.mx" }).code;

describe("solid: a `static { … }` block hoists its statements, not the block", () => {
  it.each([
    ["one line", "static { let q = 1; }", "let q = 1;\n"],
    [
      "several statements",
      "static {\n  let q = 1;\n  const r = 2;\n}",
      "let q = 1;\n  const r = 2;\n",
    ],
    ["a body of more than one block", "static { a } { b }", "{ a } { b }\n"],
  ])("%s", (_name, statement, expected) => {
    expect(out(`${statement}\n<div>\${q}</div>\n`)).toBe(
      `${expected}export interface Input {}\nexport default function T(input: Input) { return <><div>{q}</div></>; }`,
    );
  });

  it("an empty block hoists nothing", () => {
    expect(out("static {}\n<div>x</div>\n")).toBe(
      "export interface Input {}\nexport default function T(input: Input) { return <><div>x</div></>; }",
    );
  });
});
