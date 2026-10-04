import { expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

// Decision 140: `typeCheck` reaches the shared JSX emitter, with React's own
// JSX types in the preamble. Unset, the runtime output is unchanged.
const source = "<button onDblClick=((e) => e.detail)>x</button>";

it("wraps handlers against React's JSX types only under typeCheck", () => {
  const plain = compileReactMx(source, "/fixtures/test.mx").code;
  expect(plain).not.toContain("__Mx");
  expect(
    compileReactMx(source, "/fixtures/test.mx", { typeCheck: false }).code,
  ).toBe(plain);

  const { code } = compileReactMx(source, "/fixtures/test.mx", {
    typeCheck: true,
  });
  expect(code).toContain(
    'import type { JSX as __MxJSX } from "react/jsx-runtime";',
  );
  // React's own spelling (`onDoubleClick`) is what the lookup lowercases.
  expect(code).toContain(
    'onDoubleClick={((e) => e.detail) satisfies __MxH<"button", "doubleclick">}',
  );
});
