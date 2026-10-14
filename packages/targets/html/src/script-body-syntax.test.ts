// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * A `<script>` body must parse, as in stock Marko 6.4.4. The html target
 * emits none of the body, so before this a decorator or a syntax error
 * compiled and was never seen. Core's own test pins the rows
 * (`packages/core/src/script-body-syntax.test.ts`); these are the same rules
 * through `compile`.
 */

const file = "/tmp/mx-script-body-test/page.mx";

const DECORATOR =
  "Decorators are not read inside a `<script>` body: its text is TypeScript without decorator syntax. Move the decorated class to a `.ts` module and import it, or apply the decorator as a plain function call";

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(source: string, options?: { strict?: boolean }): any {
  try {
    compile(source, file, options);
  } catch (error) {
    return error;
  }
  return undefined;
}

const page = (body: string, open = "<script>") =>
  `<div/>\n${open}\n${body}\n</script>`;

describe("the html target refuses a <script> body that does not parse", () => {
  it.each([
    ["a decorator", page("@d class C {}"), DECORATOR, 3, 0, 2],
    ["a syntax error", page("const = 1;"), "Unexpected token", 3, 6, 6],
    ["an unclosed brace", page("if (x) {"), "Unexpected token", 4, 0, 0],
    ["an HTML comment", page("<!-- x -->"), "Unexpected token", 3, 1, 1],
  ])("%s", (_label, source, message, line, column, endColumn) => {
    const error = thrown(source);
    expect(error.message).toBe(message);
    expect(error.diagnosticCode).toBe("MX_INVALID_STATEMENT");
    expect([error.line, error.column]).toEqual([line, column]);
    expect(error.end).toEqual({ line: error.end.line, column: endColumn });
    expect(error.end.line).toBe(line);
  });

  it.each([
    ["a <define>", "<define/Card>\n<script>\nconst = 1;\n</script>\n</define>"],
    ["a <try>", "<try>\n<script>\nconst = 1;\n</script>\n</try>"],
    ["an <if>", "<let/x=1/>\n<if=x>\n<script>\nconst = 1;\n</script>\n</if>"],
  ])("inside %s", (_label, source) => {
    const error = thrown(source);
    expect(error?.diagnosticCode).toBe("MX_INVALID_STATEMENT");
    expect(error.message).toBe("Unexpected token");
    expect(error.column).toBe(6);
  });

  it("when the file uses CRLF line endings", () => {
    const error = thrown("<div/>\r\n<script>\r\n@d class C {}\r\n</script>");
    expect([error.line, error.column]).toEqual([3, 0]);
    expect(error.end).toEqual({ line: 3, column: 2 });
  });
});

describe("the html target accepts the <script> bodies stock Marko compiles", () => {
  it.each([
    ["an import", 'import x from "./x";'],
    ["an export", "export const y = 1;"],
    ["a top-level return", "return 1;"],
    ["a top-level await", 'await fetch("/x");'],
    ["a type annotation", "const n: number = 1;"],
    ["an enum", "enum E { A }"],
  ])("%s", (_label, body) => {
    expect(thrown(page(body))).toBeUndefined();
  });

  it("an empty body", () => {
    expect(thrown("<div/>\n<script></script>")).toBeUndefined();
  });

  it("a body that writes a <let>", () => {
    expect(thrown("<let/n=0/>\n<script>\nn = 1;\n</script>")).toBeUndefined();
  });

  it("a body with a ${…} placeholder, which is not read", () => {
    expect(
      thrown("<let/x=1/>\n<script>\nconst a = ${x};\n</script>"),
    ).toBeUndefined();
  });
});

describe("the stale read in a <script> body (review of #568, L4)", () => {
  const DERIVED =
    "<let/items=[1]/> <const/total=items.length/> <div>${total}</div>";

  it("is reported for a body that parses", () => {
    const error = thrown(
      `${DERIVED} <script> items = []; class C {}; console.log(total) </script>`,
    );
    expect(error.diagnosticCode).toBe("MX_STALE_DERIVED_READ");
  });

  it("is not skipped for a body that does not parse: the body is refused", () => {
    const error = thrown(
      `${DERIVED} <script> items = []; @d class C {}; console.log(total) </script>`,
    );
    expect(error.diagnosticCode).toBe("MX_INVALID_STATEMENT");
    expect(error.message).toBe(DECORATOR);
  });
});
