// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

/**
 * Marko 6.3.51 accepts a raw `$!{}` as the sole body of a tag with params and
 * emits the raw HTML inside the children callback. Solid has no wrapper-free
 * raw-HTML form, and hoisting the child onto `innerHTML` left the params
 * unbound (`ReferenceError: item is not defined` at render), so it is a
 * positioned compile error at the `$!{`.
 */
function failure(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    if (source.startsWith("<define")) {
      compileSolidMx(source, { filename: "fixture.solid.mx" });
    } else {
      compileSolidUnit(source, { filename: "fixture.mx" });
    }
  } catch (error) {
    const e = error as { message: string; line: number; column: number };
    return { message: e.message, line: e.line, column: e.column };
  }
  throw new Error("expected a compile error, but the template compiled");
}

const IMPORT = `import Row from "./row.mjs";\n`;

describe("raw `$!{}` body with tag params (solid)", () => {
  it.each([
    ["component", `${IMPORT}<Row|item|>$!{item}</Row>\n`, 2, 11],
    [
      "define",
      "<define/D|content|>${content}</define><D|item|>$!{item}</D>",
      1,
      47,
    ],
    ["dynamic tag", "<${input.tag}|item|>$!{item}</>\n", 1, 20],
    ["for", "<for|item| of=input.items>$!{item}</for>\n", 1, 26],
  ])(
    "rejects a sole raw child on %s at the `$!{`",
    (_name, source, line, column) => {
      const e = failure(source);
      expect(e.message).toContain(
        "raw HTML needs an element to carry `innerHTML`",
      );
      expect({ line: e.line, column: e.column }).toEqual({ line, column });
    },
  );

  it("still hoists a raw child onto innerHTML without tag params", () => {
    const { code } = compileSolidUnit(`${IMPORT}<Row>$!{input.html}</Row>\n`, {
      filename: "fixture.mx",
    });
    expect(code).toContain("innerHTML={input.html}");
  });

  it("compiles the suggested element wrapper", () => {
    const { code } = compileSolidUnit(
      `${IMPORT}<Row|item|><div innerHTML=item/></Row>\n`,
      { filename: "fixture.mx" },
    );
    expect(code).toContain(
      '<div innerHTML={__mxAttrValue("innerHTML", item, "div")}',
    );
  });
});
