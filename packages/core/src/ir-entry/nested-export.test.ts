/**
 * An `import` or `export` below the top level of an expression, pattern,
 * argument, parameter or `static`/`server`/`client` statement payload is a positioned diagnostic,
 * with the member trigger armed or not, never an internal error from the
 * TypeScript strip (which finds no program scope for it).
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Dialect } from "../syntax-table.ts";
import { lowerSource } from "./index.ts";

const memberSyntax = (
  createRequire(import.meta.url)(
    join(import.meta.dirname, "../fixtures/syntax/member-fixture.ts"),
  ) as { default: Dialect }
).default;

const MESSAGE =
  "An `import` or `export` must be a statement of the module: at the top of the file, after `static`, `server` or `client`, or directly inside that statement's `{ … }` block. This one is inside a nested block, an `if` or a function body; move it out to the block's own statements.";

describe("import or export below the top level", () => {
  it.each([
    [
      "an attribute value",
      "<div x=(() => { export { a } })/>",
      undefined,
      1,
      16,
      28,
    ],
    [
      "a trigger armed",
      "<div x=(() => { export { a } })/>",
      memberSyntax,
      1,
      16,
      28,
    ],
    [
      "a trigger operand",
      "<div x=(() => { export { &a } })/>",
      memberSyntax,
      1,
      16,
      29,
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder
    [
      "a placeholder",
      "<p>${(() => { export { a } })()}</p>",
      undefined,
      1,
      14,
      26,
    ],
    [
      "a pattern",
      "<let/{ a = () => { export { b } } }=x/>",
      undefined,
      1,
      19,
      31,
    ],
    ["arguments", "<foo(() => { export { a } })/>", undefined, 1, 13, 25],
    [
      "parameters",
      "<for|x = () => { export { a } }| of=y></for>",
      undefined,
      1,
      17,
      29,
    ],
    [
      "a static function",
      "static function f() { export { a } }\n<div/>",
      undefined,
      1,
      22,
      34,
    ],
    [
      "a static block with an if",
      "static { if (a) { export { b } } }\n<div/>",
      undefined,
      1,
      18,
      30,
    ],
    [
      "a static block after an import",
      'static { import x from "x"; function f() { export { a } } }\n<div/>',
      undefined,
      1,
      43,
      55,
    ],
  ])("%s", (_name, source, dialect, line, column, endColumn) => {
    const { diagnostics } = lowerSource(
      source,
      "/v/e.mx",
      dialect ? { dialect } : {},
    );
    expect(diagnostics).toMatchObject([
      {
        code: "MX_INVALID_STATEMENT",
        message: MESSAGE,
        line,
        column,
        end: { line, column: endColumn },
      },
    ]);
  });

  it("a block's own export still compiles", () => {
    const { diagnostics } = lowerSource(
      "static { export const z = 1 }\n<div/>",
      "/v/e.mx",
      {},
    );
    expect(diagnostics).toEqual([]);
  });

  it("an export in a namespace body is not refused", () => {
    const { diagnostics } = lowerSource(
      "static { namespace N { export const a = 1 } }\n<div/>",
      "/v/e.mx",
      {},
    );
    expect(diagnostics).toEqual([]);
  });
});
