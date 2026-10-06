import type { TranslateError } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { assertAngularParses, emit } from "./helpers.ts";

// Angular's template expression parser has no `function` keyword and no
// statement bodies (`() => { ... }` is "Multi-line arrow functions are not
// supported"). A handler that lowers to either used to compile silently to a
// template `parseTemplate` rejects; it is now a positioned MX error naming the
// construct and the working alternative.

const REJECTED: Array<[string, string]> = [
  ["method shorthand", `<button onClick() { query.set(""); }>x</button>`],
  [
    "function expression",
    `<button onClick=function () { query.set(""); }>x</button>`,
  ],
  ["block-bodied arrow", `<button onClick=() => { query.set(""); }>x</button>`],
  [
    "function nested in a call argument",
    `<button onClick=wrap(function () { go(); })>x</button>`,
  ],
  [
    "block-bodied arrow nested in a call argument",
    `<button onClick=wrap(() => { go(); })>x</button>`,
  ],
  [
    "lowercase native event spelling",
    `<button onclick=function () { go(); }>x</button>`,
  ],
];

describe("statement-bodied event handlers", () => {
  it.each(REJECTED)(
    "%s is a positioned error with the alternative",
    (_n, src) => {
      let message = "";
      let line: number | undefined;
      let column: number | undefined;
      try {
        emit(src);
      } catch (error) {
        ({ message, line, column } = error as TranslateError);
      }
      expect(message).toMatch(/Angular templates cannot contain/);
      expect(message).toMatch(/arrow with an expression body/);
      expect(message).toMatch(/handler reference/);
      expect({ line, column }).toEqual({ line: 1, column: expect.any(Number) });
    },
  );

  it.each([
    ["expression arrow", `<button onClick=() => query.set("")>x</button>`],
    ["handler reference", `<button onClick=save>x</button>`],
    ["member reference", `<button onClick=svc.save>x</button>`],
    [
      "call-arg expression arrow",
      `<button onClick=wrap(() => go())>x</button>`,
    ],
  ])("%s still compiles to a template Angular parses", (_n, src) => {
    assertAngularParses(emit(src));
  });
});

describe("statement bodies in the other template expression contexts", () => {
  it.each([
    ["dynamic attribute", `<div title=(function () { return 1; })()>x</div>`],
    ["interpolation", `<div>\${(function () { return 1; })()}</div>`],
    ["<if>", `<if=(function () { return 1; })()>x</if>`],
    [
      "<for> list",
      `<for|i| of=items.filter(function (x) { return x; })>\${i}</for>`,
    ],
    ["<const>", `<const/a=(() => { return 1; })()/><p>\${a}</p>`],
    ["class", `<div class=(function () { return 1; })()>x</div>`],
    ["class object", `<div class={ a: (() => { return 1; })() }>x</div>`],
    [
      "interpolated call argument",
      `<div>\${items.map(function (i) { return i; })}</div>`,
    ],
  ])("%s is rejected before Angular's parser sees it", (_n, src) => {
    expect(() => emit(src)).toThrow(/Angular templates cannot contain/);
  });

  it("does not flag the word `function` in a string or a comment", () => {
    assertAngularParses(emit(`<div>\${"function () { }"}</div>`));
  });
});
