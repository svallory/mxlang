import { describe, expect, it } from "vitest";
import { compileReactMx } from "./index.ts";

/** Native elements normalize primitive attribute values; component props stay raw (decision 149). */
describe("react primitive attribute normalization", () => {
  const compile = (source: string) =>
    compileReactMx(source, "/virtual/page.mx").code;

  it("leaves component props untouched", () => {
    const code = compile(
      'import Card from "./card.mx"\n<Card title=input.t data-x=input.d class=input.c disabled=input.f/>',
    );
    const call = code.slice(code.indexOf("<Card"));
    expect(call).toContain("title={input.t}");
    expect(call).toContain("data-x={input.d}");
    expect(call).toContain("disabled={input.f}");
    expect(call).not.toMatch(/<Card[^>]*__mxAttr/);
  });

  it("routes native dynamic attributes, class included, through the helper", () => {
    const code = compile("<div data-x=input.d class=input.c/>");
    expect(code).toContain('__mxAttrValue("data-x", input.d, "div")');
    expect(code).toContain('__mxAttrValue("class", input.c, "div")');
    expect(compile("<div ...input.rest/>")).toContain(
      '__mxAttrSpread({ ...input.rest }, "div"',
    );
  });

  it("keeps static attributes byte-identical", () => {
    const code = compile('<div data-x="1" class="a b" disabled/>');
    expect(code).toContain('data-x="1"');
    expect(code).not.toContain("__mxAttrValue");
  });
});

describe("react string style in a spread (decision 149)", () => {
  const compile = (source: string) =>
    compileReactMx(source, "/virtual/page.mx").code;

  it("refuses a literal string/true style at compile time", () => {
    for (const style of ['"color: red"', "true", "`x`"])
      expect(() => compile(`<div ...{style: ${style}}/>`)).toThrow(
        "`style` in a spread must be an object on React",
      );
  });

  it("accepts object, null and runtime values", () => {
    expect(() => compile("<div ...{style: {color: 'red'}}/>")).not.toThrow();
    expect(() => compile("<div ...{style: null}/>")).not.toThrow();
    expect(() => compile("<div ...{style: input.s}/>")).not.toThrow();
  });
});
