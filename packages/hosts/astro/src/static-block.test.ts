// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/** `static { … }` hoists its statements into the frontmatter with the braces gone, as stock Marko 6.4.4 does. */
import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

const out = (source: string): string =>
  lowerAstroMx(source, "/f/t.astro.mx").code;

describe("astro: a `static { … }` block hoists its statements, not the block", () => {
  it.each([
    ["one line", "static { let q = 1; }", "let q = 1;"],
    [
      "several statements",
      "static {\n  let q = 1;\n  const r = 2;\n}",
      "let q = 1;\n  const r = 2;",
    ],
    ["a body of more than one block", "static { a } { b }", "{ a } { b }"],
  ])("%s", (_name, statement, expected) => {
    expect(out(`${statement}\n<div>\${q}</div>\n`)).toBe(
      `---\n${expected}\n---\n<div>{q}</div>`,
    );
  });

  it("an empty block hoists nothing", () => {
    expect(out("static {}\n<div>x</div>\n")).not.toContain("{}");
  });
});
