import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { isTranslateError } from "./core.ts";
import {
  checkReservedSource,
  reservedBindingMessage,
} from "./reserved-bindings.ts";
import { lookup } from "./test-targets.ts";

const compile = (source: string) =>
  compileSource(
    source,
    "/tmp/reserved.mx",
    {
      tags: {},
      isElement: () => true,
      isComponent: () => false,
    },
    { targets: lookup, emitIr: () => "" },
  );

describe("reserved generated-code bindings", () => {
  it.each([
    "<const/__mxX=1/>",
    "<let/__mxX=1/>",
    "<id/__mxX/>",
    "<custom/__mxX/>",
    "<const/{ x: __mxX }=input/>",
    "<const/[x, ...__mxX]=input/>",
    "<define/__mxX>hi</define>",
    "<define/F|__mxX|>hi</define>",
    "<for|{x: __mxX}| of=input.items><p/></for>",
    "<Component|__mxX|><p/></Component>",
    "<Component><@body|__mxX|>hi</@body></Component>",
    "static const __mxX = 1",
    "server const __mxX = 1",
    "client const __mxX = 1",
    "static function f(__mxX) {}",
    "static class __mxX {}",
    "export const __mxX = 1",
    "import { x as __mxX } from 'x'",
    "import __mxX from 'x'",
    "import * as __mxX from 'x'",
    "import type { X as __mxX } from 'x'",
    "$ const __mxX = 1",
    "<p>${((__mxX) => __mxX)(1)}</p>",
    "<const/\\u005f_mxX=1/>",
  ])("positions %s at the binding", (source) => {
    let failure: unknown;
    try {
      compile(`\n${source}\n`);
    } catch (error) {
      failure = error;
    }
    expect(isTranslateError(failure)).toBe(true);
    if (!isTranslateError(failure)) return;
    expect(failure.message).toBe(reservedBindingMessage("__mxX"));
    expect(failure.line).toBe(2);
    expect(failure.column).toBe(
      source.indexOf("__mxX") >= 0
        ? source.indexOf("__mxX")
        : source.indexOf("\\u005f"),
    );
  });

  it("does not reserve property names, import source names, strings or references", () => {
    expect(() =>
      compile(
        'import { __mxX as safe } from "x"\nstatic const obj = { __mxX: 1 };\n<p>${obj.__mxX}</p>',
      ),
    ).not.toThrow();
    expect(() =>
      checkReservedSource(
        'const safe = "__mxX"; obj.__mxX; const {__mxX: value} = obj;',
      ),
    ).not.toThrow();
  });

  it("checks nested host-only declarations and escaped bindings", () => {
    for (const source of [
      "function f() { const __mxX = 1; }",
      "try {} catch (__mxX) {}",
      "const \\u005f_mxX = 1;",
      "const __mxX = <number>1;",
      "const f = (__mxX: number) => <p/>;",
    ]) {
      expect(() => checkReservedSource(source, 4)).toThrow(
        reservedBindingMessage("__mxX"),
      );
    }
  });
});
