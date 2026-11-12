/**
 * An `export` inside an arrow in an attribute value or a placeholder is a
 * positioned diagnostic, with the member trigger armed or not, never an
 * internal error from the TypeScript strip (which finds no program scope for
 * it).
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
  "`export` is only allowed at the top level of a module, not inside a function or a block.";

describe("export below the top level", () => {
  it.each([
    ["without a trigger", "<div x=(() => { export { a } })/>", undefined, 16],
    [
      "with a trigger armed",
      "<div x=(() => { export { a } })/>",
      memberSyntax,
      16,
    ],
    [
      "a trigger operand",
      "<div x=(() => { export { &a } })/>",
      memberSyntax,
      16,
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder
    ["a placeholder", "<p>${(() => { export { a } })()}</p>", undefined, 14],
  ])("%s", (_name, source, dialect, column) => {
    const { diagnostics } = lowerSource(
      source,
      "/v/e.mx",
      dialect ? { dialect } : {},
    );
    expect(diagnostics).toMatchObject([
      {
        code: "MX_INVALID_STATEMENT",
        message: MESSAGE,
        line: 1,
        column,
      },
    ]);
  });
});
