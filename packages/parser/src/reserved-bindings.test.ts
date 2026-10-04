import { isTranslateError, reservedBindingMessage } from "@mxlang/core";
import { expect, it } from "vitest";
import { parse } from "./index.ts";

it.each(["solid", "ng"])(
  "checks authored %s host code before region emission",
  (host) => {
    for (const binding of [
      "const __mxX = 1;",
      "let __mxX = 1;",
      "import {x as __mxX} from 'x';",
      "function f({x: __mxX}) {}",
      "const \\u005f_mxX = 1;",
    ]) {
      let error: unknown;
      try {
        parse(`\n${binding}\nconst view = <p/>;`, `probe.${host}.mx`, {
          mx: true,
          mxRegionCompile: () => ({ code: "null" }),
        });
      } catch (e) {
        error = e;
      }
      expect(isTranslateError(error)).toBe(true);
      if (!isTranslateError(error)) continue;
      expect(error.message).toBe(reservedBindingMessage("__mxX"));
      expect(error.line).toBe(2);
      expect(error.column).toBe(
        binding.indexOf("__mxX") >= 0
          ? binding.indexOf("__mxX")
          : binding.indexOf("\\u005f"),
      );
    }
  },
);

it("leaves ordinary TypeScript and generated replacements alone", () => {
  expect(() =>
    parse("const __mxX = 1", "probe.ts", { mx: false }),
  ).not.toThrow();
  expect(() =>
    parse("const view = <p/>;", "probe.solid.mx", {
      mxRegionCompile: () => ({
        code: "(() => { const __mxGenerated = 1; return __mxGenerated; })()",
      }),
    }),
  ).not.toThrow();
});
