/**
 * `public.d.ts` is what other programs typecheck the front end against (the
 * `types` condition of `@mxlang/parser/frontend`): pinned to the source so
 * the two cannot drift.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { lineColumnAt, ParseOptions, parse } from "./index.ts";
import type * as Declared from "./public.d.ts";

describe("public.d.ts", () => {
  it("declares parse and lineColumnAt as the source defines them", () => {
    expectTypeOf<typeof parse>().toExtend<typeof Declared.parse>();
    expectTypeOf<ReturnType<typeof Declared.parse>>().toEqualTypeOf<
      ReturnType<typeof parse>
    >();
    expectTypeOf<typeof lineColumnAt>().toExtend<
      typeof Declared.lineColumnAt
    >();
  });

  it("every option the source takes is declared (`syntax` as a plain object, validated at run time)", () => {
    expectTypeOf<ParseOptions>().toExtend<Declared.ParseOptions>();
    expectTypeOf<keyof ParseOptions>().toEqualTypeOf<
      keyof Declared.ParseOptions
    >();
  });
});
