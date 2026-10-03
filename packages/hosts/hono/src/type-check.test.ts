import { expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

// Decision 140: `typeCheck` reaches the shared JSX emitter, with Hono's own
// JSX types in the preamble. Unset, the runtime output is unchanged.
const source = "<button onClick=((e) => e.detail)>x</button>";

it("wraps handlers against Hono's JSX types only under typeCheck", () => {
  const plain = compileHonoMx(source, "/fixtures/test.mx").code;
  expect(plain).not.toContain("__mx");
  expect(
    compileHonoMx(source, "/fixtures/test.mx", { typeCheck: false }).code,
  ).toBe(plain);

  const { code } = compileHonoMx(source, "/fixtures/test.mx", {
    typeCheck: true,
  });
  expect(code).toContain(
    'import type { JSX as __MxJSX } from "hono/jsx/jsx-runtime";',
  );
  expect(code).toContain(
    '((e) => e.detail) satisfies __MxH<"button", "click">',
  );
});
