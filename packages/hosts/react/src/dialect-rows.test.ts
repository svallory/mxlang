// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

// The shared JSX emitter is pinned in `@mxlang/host-preact`; this row proves
// the react entry reaches it.
describe("react: <html-script> refuses an event handler", () => {
  it("at the attribute", () => {
    let error: unknown;
    try {
      compileReactMx(
        "<html-script onclick() { go() }>x</html-script>",
        "/fixtures/script.mx",
      );
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toMatchObject({
      message: expect.stringMatching(
        /`onclick\(\.\.\.\)` on `<html-script>` is an event handler/,
      ),
      line: 1,
      column: 13,
    });
  });
});

describe("react: a sequence placeholder as the only child of a branch", () => {
  // React has no placeholder guard, so nothing else wraps the sequence: bare,
  // `c ? 0, x : null` is a syntax error.
  it("parses", () => {
    const { code } = compileReactMx(
      "<if=input.a>${0, input.x}</if>",
      "/fixtures/seq.mx",
    );
    expect(() =>
      parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
  });
});
