import { describe, expect, it } from "vitest";
import { compileSource, printExpression } from "./compile.ts";
import { newCtx, TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { lower } from "./lower.ts";
import { SUGAR_AFTER_DEFAULT_MESSAGE } from "./stock-parser.ts";
import { lookup } from "./test-targets.ts";

/**
 * Decision 151, ruling 2: the default attribute is exempt from the after-value
 * rule, so sugar right after its value is one positioned MX error, through the
 * MX front end. (Ruling 1's stock-parser diagnostics are gone: core never
 * parses MX with a stock `htmljs-parser` since port PR 5.)
 */

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

describe("sugar right after a default value", () => {
  // [source, line (1-based), column (0-based) of the sugar, token]
  const CASES: [string, number, number, string][] = [
    ["<if=x :b>y</if>", 1, 6, ":b"],
    ["<let/x=1 :b/>", 1, 9, ":b"],
    ["if=x :b", 1, 5, ":b"],
    ["<const/x=a ? b : c :d/>", 1, 19, ":d"],
    ["<div/>\n<if=x :b>y</if>", 2, 6, ":b"],
  ];

  it.each(CASES)("compileSource: %j", (source, line, column, token) => {
    const error = viaCompile(source);
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({
      message: SUGAR_AFTER_DEFAULT_MESSAGE(token),
      line,
      column,
    });
  });

  // With no template error the fragment's container keeps the parse error
  // and lowering raises it; the boundary gives it the same text. (`<let/x>`
  // is left out: this test host refuses its tag variable, which lowering
  // checks before the value.)
  it.each(CASES.filter(([source]) => !source.startsWith("<let")))(
    "parseFragment + lower: %j",
    (source, line, column, token) => {
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
        message: SUGAR_AFTER_DEFAULT_MESSAGE(token),
        line,
        column,
      });
    },
  );

  // `parseFragment` throws only for a template error, carrying the expression
  // errors before it; the sugar one among them is the one rewritten, at the
  // fragment's shifted position.
  it.each([
    [{}, 1, 6],
    [{ baseLine: 3, baseColumn: 2, baseOffset: 5 }, 4, 8],
  ])("parseFragment, before a template error (%j)", (base, line, column) => {
    const error = viaFragment("<if=x :b>y</if>\n<div", base);
    expect(error).toBeInstanceOf(TranslateError);
    expect(error).toMatchObject({
      message: SUGAR_AFTER_DEFAULT_MESSAGE(":b"),
      line,
      column,
    });
  });

  it("names the rule and the way out", () => {
    expect(SUGAR_AFTER_DEFAULT_MESSAGE(":b")).toBe(
      '`:b` right after a default value is not supported (decision 151, ruling 2); put it before the value or on the tag (`<input:email type="email">`). See "the parser after-value rule" in divergences.md.',
    );
  });

  it.each([
    // A named attribute's value ends at whitespace: the sugar is its own attribute.
    '<input type="email" :email/>',
    // `.b` after a default value stays member access.
    "<const/x=a .b/>",
  ])("%j compiles", (source) => {
    expect(viaCompile(source)).toBeUndefined();
  });
});
