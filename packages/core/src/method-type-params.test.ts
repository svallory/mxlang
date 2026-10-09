import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { newCtx, type TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { type FragmentBase, parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { lookup } from "./test-targets.ts";

/**
 * `x<A<B>>(a) {b}` is not a method with nested generics: `A<B>` is not a type
 * parameter (a parameter is a name, then `extends`/`=`: `<A extends B<C>>`).
 * Marko records a parse error for it, but its `source` output printed the tree
 * first and threw `unknown node of type undefined with constructor "Array"`,
 * which hid the error. On the MX front end the type parameters' container
 * keeps the parse error and lowering raises it, positioned.
 */

const host: HostDeclarations = {
  name: "method-type-params-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

/** `fragment` parsed at `options`' base inside `file`, then lowered. */
function thrown(
  fragment: string,
  file = fragment,
  options: FragmentBase = {},
): TranslateError | undefined {
  try {
    const ctx = newCtx(
      file,
      printExpression,
      host,
      undefined,
      "/tmp/fragment.mx",
      lookup,
    );
    lower(ctx, parseFragment(fragment, options).body);
  } catch (error) {
    return error as TranslateError;
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
    expect(error?.line).toBe(1);
    expect(error?.column).toBeGreaterThan(6);
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

  it("the error's position is the file's when the fragment has a base", () => {
    // Line 3, column 4 is offset 10 of the file: two short lines, then four
    // spaces before the fragment.
    const fragment = "<div x<A<B>>(a) {b}/>";
    const error = thrown(fragment, `ab\ncd\n    ${fragment}`, {
      baseOffset: 10,
      baseLine: 2,
      baseColumn: 4,
      filename: "f.mx",
    });
    expect(error).toMatchObject({ line: 3 });
    expect(error?.column).toBeGreaterThan(10);
  });
});
