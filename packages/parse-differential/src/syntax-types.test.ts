/**
 * Decision 182, PR C: `@mxlang/core` declares its own `SyntaxTable` and
 * `Trigger` (its published `.d.ts` may not name the private
 * `@mxlang/parser`). This pins the two declarations equal, field for field,
 * until parser port PR 4 bundles the front end into core. It lives here
 * because this private package already depends on both.
 */
import type * as Core from "@mxlang/core";
import type * as Parser from "@mxlang/parser";
import { expectTypeOf, it } from "vitest";

it("core's SyntaxTable and Trigger are the parser's", () => {
  expectTypeOf<Core.SyntaxTable>().toEqualTypeOf<Parser.SyntaxTable>();
  expectTypeOf<Core.Trigger>().toEqualTypeOf<Parser.Trigger>();
  expectTypeOf<Core.StandIn>().toEqualTypeOf<Parser.StandIn>();
  expectTypeOf<Core.TriggerNode>().toEqualTypeOf<Parser.TriggerNode>();
  expectTypeOf<Core.SyntaxDiagnostic>().toEqualTypeOf<Parser.SyntaxDiagnostic>();
});
