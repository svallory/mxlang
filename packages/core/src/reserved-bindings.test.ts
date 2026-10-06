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

  it.each([
    [
      "decorated class",
      "static function d(){ return (x:any)=>x }\nstatic @d() class __mxX {}",
    ],
    [
      "decorated method parameter",
      "static function d(){ return (x:any)=>x }\nstatic class A { @d() m(__mxX){} }",
    ],
    [
      "legacy decorator",
      "static function d(){ return (x:any)=>x }\nstatic class A { @d m(__mxX){} }",
    ],
  ])("checks a %s in a statement tag", (_label, source) => {
    const statement = source.split("\n").slice(1).join("\n");
    let failure: unknown;
    try {
      compile(`\n${source}\n`);
    } catch (error) {
      failure = error;
    }
    expect(isTranslateError(failure)).toBe(true);
    if (!isTranslateError(failure)) return;
    expect(failure.message).toBe(reservedBindingMessage("__mxX"));
    expect(failure.line).toBe(3);
    expect(failure.column).toBe(statement.indexOf("__mxX"));
  });

  it("does not treat a decorated method's own name as a binding", () => {
    // A class method name is a property key, not a declaration, so the same
    // check that allows `m(__mxX) {}` allows `__mxX() {}`.
    expect(() =>
      compile(
        "\nstatic function d(){ return (x:any)=>x }\nstatic class A { @d __mxX(){} }\n",
      ),
    ).not.toThrow();
  });

  it("never invents a rejection from malformed statement text", () => {
    // A statement's text is code the parser no longer reads as attributes
    // (decision 168), so a malformed one is no longer a Marko syntax error here:
    // it passes through to TypeScript, as on html. This check must not turn it
    // into a reserved-binding rejection.
    try {
      compile("\nstatic const = ;\n");
    } catch (error) {
      expect((error as Error).message).not.toContain("reserved");
    }
  });

  it("does not reject type-only names", () => {
    // These are module-level TypeScript, so they go through the source check
    // directly: `static declare function` is not a statement tag Marko accepts
    // (`declare` in an attribute position is a syntax error there), and the
    // reservation must not change which module code compiles.
    const typeOnly = [
      "type __ = infer __mxU extends string ? 1 : 0",
      "type M<__mxK extends keyof T> = { [P in __mxK]: T[P] }",
      "declare function f(__mxA: number): void",
      "interface I { m(__mxA: number): void }",
      "const g = (x: __mxA): void => {}",
      "declare const h: <__mxP>(x: __mxP) => void",
      "function f<__mxT>(x: __mxT): __mxT { return x }",
      "enum E { __mxN = 1 }",
    ];
    for (const source of typeOnly) {
      expect(() => checkReservedSource(source, 4)).not.toThrow();
    }
  });

  it("rejects a top-level return's own parse failure by default", () => {
    // A plain module cannot hold a top-level `return`, so the default parse
    // rejects it — and a caller that wanted the host-legal form must say so.
    expect(() => checkReservedSource('return Astro.redirect("/");')).toThrow(
      /'return' outside of function/,
    );
  });

  it("accepts a top-level return when the caller opts in", () => {
    // The Astro fence is the one authored region a host compiles inside a
    // function body, so its top-level `return` is legal there.
    expect(() =>
      checkReservedSource('const a = 1;\nreturn Astro.redirect("/");', 2, 0, {
        allowReturnOutsideFunction: true,
      }),
    ).not.toThrow();
  });

  it("still reserves __mx bindings inside a return-holding fence", () => {
    // The relaxation is a grammar one only; it must not weaken the check.
    let failure: unknown;
    try {
      checkReservedSource("const __mxX = 1;\nreturn __mxX;", 2, 0, {
        allowReturnOutsideFunction: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(isTranslateError(failure)).toBe(true);
    if (isTranslateError(failure)) {
      expect(failure.message).toBe(reservedBindingMessage("__mxX"));
      // File line 2: the fence's second line is file line 3 only because the
      // caller passed the fence's own start; core reports what it was given.
      expect(failure.line).toBe(2);
    }
  });

  it("still rejects an ordinary declare function's own name", () => {
    let failure: unknown;
    try {
      checkReservedSource("declare function __mxX(a: number): void", 4);
    } catch (error) {
      failure = error;
    }
    expect(isTranslateError(failure)).toBe(true);
    if (isTranslateError(failure)) {
      expect(failure.message).toBe(reservedBindingMessage("__mxX"));
      expect(failure.line).toBe(4);
    }
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
