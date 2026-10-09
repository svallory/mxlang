import { describe, expect, it } from "vitest";
import { parseFragment } from "./fragment.ts";

/**
 * `x<A<B>>(a) {b}` is not a method with nested generics: `A<B>` is not a type
 * parameter (a parameter is a name, then `extends`/`=`: `<A extends B<C>>`).
 * Marko records a parse error for it, but its `source` output printed the tree
 * first and threw `unknown node of type undefined with constructor "Array"`,
 * which hid the error. `parseFragment` now surfaces Marko's positioned one.
 */

function thrown(source: string): { message: string } | undefined {
  try {
    parseFragment(source);
  } catch (error) {
    return error as { message: string };
  }
  return undefined;
}

describe("a method's type parameters", () => {
  it.each([
    "<div x<A<B>>(a) {b}/>",
    "<div x<A<B>>(a) {b}></div>",
    "<div x<A!>(a) {b}/>",
    "<div x<>(a) {b}/>",
    "<div x<1>(a) {b}/>",
  ])("%j reports a positioned parse error", (source) => {
    const error = thrown(source);
    expect(error).toBeDefined();
    expect(error?.message).not.toMatch(/unknown node of type undefined/);
    expect(error?.message).toMatch(/fragment\.mx:1:\d+/);
  });

  it("points at the offending token", () => {
    expect(thrown("<div x<A<B>>(a) {b}/>")?.message).toContain(
      'Unexpected token, expected ","',
    );
  });

  it.each([
    "<div x<A>(a) {b}/>",
    "<div x<A, B>(a) {b}/>",
    "<div x<A extends B<C>>(a) {b}/>",
    "<div x<A extends B<C<D>>>(a) {b}/>",
    "<div x<A = B<C>>(a) {b}/>",
  ])("%j, a valid list, parses", (source) => {
    expect(thrown(source)).toBeUndefined();
  });

  it("the error's loc is shifted by the fragment's base", () => {
    try {
      parseFragment("<div x<A<B>>(a) {b}/>", {
        baseOffset: 10,
        baseLine: 2,
        baseColumn: 4,
        filename: "f.mx",
      });
      throw new Error("did not throw");
    } catch (error) {
      const loc = (error as { loc: { start: { line: number } } }).loc;
      expect(loc.start.line).toBe(3);
    }
  });
});
