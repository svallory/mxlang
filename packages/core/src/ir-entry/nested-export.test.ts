/**
 * An `import` or `export` below the top level of an expression, pattern,
 * argument, parameter or `$` scriptlet payload is a positioned diagnostic,
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
    ],
    [
      "a trigger armed",
      "<div x=(() => { export { a } })/>",
      memberSyntax,
      1,
      16,
    ],
    [
      "a trigger operand",
      "<div x=(() => { export { &a } })/>",
      memberSyntax,
      1,
      16,
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder
    ["a placeholder", "<p>${(() => { export { a } })()}</p>", undefined, 1, 14],
    ["a pattern", "<let/{ a = () => { export { b } } }=x/>", undefined, 1, 19],
    ["arguments", "<foo(() => { export { a } })/>", undefined, 1, 13],
    [
      "parameters",
      "<for|x = () => { export { a } }| of=y></for>",
      undefined,
      1,
      17,
    ],
    [
      "a scriptlet function",
      "$ function f() { export { a } }\n<div/>",
      undefined,
      1,
      17,
    ],
    [
      "a scriptlet block",
      "$ { if (a) { export { b } } }\n<div/>",
      undefined,
      1,
      13,
    ],
  ])("%s", (_name, source, dialect, line, column) => {
    const { diagnostics } = lowerSource(
      source,
      "/v/e.mx",
      dialect ? { dialect } : {},
    );
    expect(diagnostics).toMatchObject([
      { code: "MX_INVALID_STATEMENT", message: MESSAGE, line, column },
    ]);
  });

  it("an export in a namespace body is not refused", () => {
    const { diagnostics } = lowerSource(
      "<div x=(() => { namespace N { export const a = 1 } })/>",
      "/v/e.mx",
      {},
    );
    expect(diagnostics.map((d) => d.code)).not.toContain(
      "MX_INVALID_STATEMENT",
    );
  });
});
