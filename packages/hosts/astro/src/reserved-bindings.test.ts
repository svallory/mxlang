import { reservedBindingMessage } from "@mxlang/core";
import { expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

it.each([
  "const __mxX = 1;",
  "import {x as __mxX} from 'x';",
  "function f({x: __mxX}) {}",
  "const \\u005f_mxX = 1;",
  "const f = (__mxX) => <p/>;",
])("positions reserved Astro fence bindings: %s", (binding) => {
  let error: unknown;
  try {
    lowerAstroMx(`---\n${binding}\n---\n<p/>`, "probe.astro.mx");
  } catch (e) {
    error = e;
  }
  expect(error).toMatchObject({
    message: reservedBindingMessage("__mxX"),
    line: 2,
    column:
      binding.indexOf("__mxX") >= 0
        ? binding.indexOf("__mxX")
        : binding.indexOf("\\u005f"),
  });
});

it("permits reserved property names and does not reject generated guards", () => {
  expect(() =>
    lowerAstroMx(
      '---\nconst data = { __mxX: "ok" };\n---\n<p title=data.__mxX/>',
      "probe.astro.mx",
    ),
  ).not.toThrow();
});
