// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * Marko makes a `<define>` tag's attributes properties of its value
 * (`${D.a}`). Solid hoists a define to a module-level function under a
 * generated name and does not rewrite a template expression's `D` to it, so
 * the property could never be read: the compile used to succeed and `D.a`
 * read an undeclared `D`. It is a positioned error at the first attribute.
 */
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(source: string): any {
  try {
    compileSolidMx(source, { filename: "/f/t.solid.mx" });
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("solid: attributes on a <define> are refused, not dropped", () => {
  it("names the property the author would read, at the first attribute", () => {
    const source = '<define/D a=1 b="s"><p>x</p></define><p>${D.a}</p>';
    const error = thrown(source);
    expect(error.message).toBe(
      "attributes on `<define/D>` are not supported in embedded MX on Solid: the define is hoisted to a function, so `D.a` cannot be read. Pass the value as a param (`<define/D|value|>`) or declare it in the surrounding TypeScript module",
    );
    expect([error.line, error.column]).toEqual([1, source.indexOf("a=1")]);
  });

  it("a spread is refused too, naming its properties", () => {
    expect(thrown("<define/D ...input.rest/>").message).toContain(
      "so its properties cannot be read",
    );
  });

  it("a define with no attributes still compiles", () => {
    expect(thrown("<define/D><p>x</p></define><D/>")).toBeUndefined();
  });
});
