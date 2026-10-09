/**
 * `public.d.ts` is what other programs typecheck the template lexer against
 * (the `types` condition of `@mxlang/parser/lexer`): pinned to the source so
 * the two cannot drift.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { type createParser, type Handlers, TagType } from "./index.ts";
import type * as Declared from "./public.d.ts";

describe("public.d.ts (@mxlang/parser/lexer)", () => {
  it("declares createParser so every declared call is a valid source call", () => {
    expectTypeOf<typeof createParser>().toExtend<
      typeof Declared.createParser
    >();
  });

  it("declares every handler the source takes, with a payload the source passes", () => {
    expectTypeOf<keyof Handlers>().toEqualTypeOf<keyof Declared.Handlers>();
    expectTypeOf<Declared.Handlers>().toExtend<Handlers>();
  });

  it("declares TagType's values as the source defines them", () => {
    expect({ ...TagType }).toEqual({ html: 0, text: 1, void: 2, statement: 3 });
    expectTypeOf<typeof TagType.statement>().toEqualTypeOf<
      typeof Declared.TagType.statement
    >();
  });
});
