import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import { newCtx, TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { lookup } from "./test-targets.ts";

/**
 * A ` :b` right after a default value is Marko's own failure, at the `:`:
 * the default attribute's value does not end at whitespace, so the value is
 * two expressions (stock `@marko/compiler` 5.42.11 on `htmljs-parser` 5.18.0,
 * probed: `<has-many=a :y/>` is "Expected a single expression, but found `:`
 * after it." at 1:13, the `:`).
 */
const MARKO = "Expected a single expression, but found `:` after it.";

const host: HostDeclarations = {
  name: "sugar-after-default-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

function viaCompile(source: string): unknown {
  try {
    compileSource(source, "/tmp/sugar-after-default.mx", host, {
      targets: lookup,
      emitIr: () => "",
    });
  } catch (error) {
    return error;
  }
  return undefined;
}

function viaFragment(source: string, base: object = {}): unknown {
  try {
    parseFragment(source, base);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("a `:name` right after a value", () => {
  // [source, line (1-based), column (0-based) of the `:`, token]
  const CASES: [string, number, number, string][] = [
    ["<if=x :b>y</if>", 1, 6, ":b"],
    ["<let/x=1 :b/>", 1, 9, ":b"],
    ["if=x :b", 1, 5, ":b"],
    ["<const/x=a ? b : c :d/>", 1, 19, ":d"],
    ["<div/>\n<if=x :b>y</if>", 2, 6, ":b"],
    // A named attribute's value does not end there either.
    ['<input type="email" :email/>', 1, 20, ":email"],
  ];

  /** Marko's parse error carries its position on `loc.start`. */
  const located = (error: unknown) => {
    type Located = { message: string; loc?: { start?: object } };
    // A `CompileErrors` aggregate carries the failure on its first error.
    const first =
      (error as { errors?: Located[] }).errors?.[0] ?? (error as Located);
    return { message: first.message, ...first.loc?.start };
  };

  it.each(CASES)("compileSource: %j", (source, line, column) => {
    expect(located(viaCompile(source))).toMatchObject({
      message: expect.stringContaining(MARKO),
      line,
      column,
    });
  });

  // With no template error the fragment's container keeps the parse error
  // and lowering raises it; the boundary gives it the same text. (`<let/x>`
  // is left out: this test host refuses its tag variable, which lowering
  // checks before the value.)
  it.each(
    CASES.filter(
      ([source]) => !source.startsWith("<let") && !source.startsWith("<input"),
    ),
  )("parseFragment + lower: %j", (source, line, column) => {
    let error: unknown;
    try {
      const ctx = newCtx(
        source,
        printExpression,
        host,
        undefined,
        "/tmp/sugar-after-default.mx",
        lookup,
      );
      lower(ctx, parseFragment(source).body);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({
      message: expect.stringContaining(MARKO),
      line,
      column,
    });
  });

  // `parseFragment` throws only for a template error, carrying the expression
  // errors before it, at the fragment's shifted position.
  it.each([
    [{}, 1, 6],
    [{ baseLine: 3, baseColumn: 2, baseOffset: 5 }, 4, 8],
  ])("parseFragment, before a template error (%j)", (base, line, column) => {
    const error = viaFragment("<if=x :b>y</if>\n<div", base);
    expect(located(error)).toMatchObject({
      message: expect.stringContaining(MARKO),
      line,
      column,
    });
  });

  it.each([
    // `.b` after a default value stays member access.
    "<const/x=a .b/>",
  ])("%j compiles", (source) => {
    expect(viaCompile(source)).toBeUndefined();
  });
});
