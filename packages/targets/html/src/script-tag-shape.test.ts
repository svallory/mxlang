// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * A built-in `<script>` takes no attribute but its own value and no `${…}`
 * placeholder in its body: the tag is client code, html emits nothing for it,
 * so both were silently discarded. Stock Marko 6.4.4 refuses them. The core
 * rule is pinned in `packages/core/src/script-tag-shape.test.ts`; this pins it
 * through the html target's compile, whose `<script>` declaration is inert.
 */

const file = "/tmp/mx-script-shape-test/page.mx";

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(source: string, options?: { strict?: boolean }): any {
  try {
    compile(source, file, options);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("the html target refuses a <script> attribute", () => {
  it.each([
    ["async", "<div/>\n<script async>\n  go();\n</script>\n", 2, 8, 13],
    ['src="/x.js"', '<div/>\n<script src="/x.js"></script>\n', 2, 8, 19],
    [
      "type after the tag's own value",
      '<div/>\n<script value=() => {} type="module"></script>\n',
      2,
      23,
      36,
    ],
  ])("%s", (_name, source, line, column, endColumn) => {
    const error = thrown(source);
    expect(error.diagnosticCode).toBe("MX_INERT_TAG_SHAPE");
    expect(error.message).toContain(
      "For a native html `<script>` element use `<html-script>`",
    );
    expect([error.line, error.column]).toEqual([line, column]);
    expect(error.end).toEqual({ line, column: endColumn });
  });

  it("still accepts <html-script> with the same attributes", () => {
    expect(
      thrown('<div/>\n<html-script async src="/x.js"></html-script>\n'),
    ).toBeUndefined();
  });

  it("still accepts the tag's own value", () => {
    expect(
      thrown("<div/>\n<script value=() => {}></script>\n"),
    ).toBeUndefined();
  });
});

describe("the html target refuses a <script> body placeholder", () => {
  it("in code, at the placeholder", () => {
    const source = "<div/>\n<script>\n  const a = ${x};\n</script>\n";
    const error = thrown(source);
    expect(error.diagnosticCode).toBe("MX_INERT_TAG_SHAPE");
    expect(error.message).toContain(
      "a `${…}` placeholder in it is not supported",
    );
    expect(error.message).toContain("`<html-script>`");
    expect([error.line, error.column]).toEqual([3, 12]);
    expect(error.end).toEqual({ line: 3, column: 16 });
  });

  it("in a quoted string, at the placeholder", () => {
    const error = thrown('<div/>\n<script>\n  const a = "${x}";\n</script>\n');
    expect(error.diagnosticCode).toBe("MX_INERT_TAG_SHAPE");
    expect([error.line, error.column]).toEqual([3, 13]);
    expect(error.end).toEqual({ line: 3, column: 17 });
  });

  it("is a refusal where the body used to be skipped, so the body is read", () => {
    // The same source without the placeholder compiles; with it, the pieces
    // around the placeholder are not parsed, so only the one error is raised
    // and it is the placeholder's, not a syntax error of the surrounding text.
    expect(thrown("<div/>\n<script>\n  const a = 1;\n</script>\n")).toBe(
      undefined,
    );
    const error = thrown("<div/>\n<script>\n  const = ${x};\n</script>\n");
    expect(error.diagnosticCode).toBe("MX_INERT_TAG_SHAPE");
    expect([error.line, error.column]).toEqual([3, 10]);
  });

  it("does not refuse a template literal's ${…}", () => {
    expect(
      thrown("<div/>\n<script>\n  const a = `${x}`;\n</script>\n"),
    ).toBeUndefined();
  });

  it("keeps the placeholder of <html-script>, which interpolates", () => {
    const { code } = compile(
      "<div/>\n<html-script>\n  const a = ${1 + 1};\n</html-script>\n",
      file,
    );
    expect(code).toContain("<script>");
    expect(code).toContain("__mxTextOf(1 + 1)");
  });
});
