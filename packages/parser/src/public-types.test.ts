import type {
  MxRegionCompile as PublicMxRegionCompile,
  MxRegionCompileInput as PublicMxRegionCompileInput,
  MxRegionCompileResult as PublicMxRegionCompileResult,
  MxRegionContext as PublicMxRegionContext,
  MxRegionHoistedImport as PublicMxRegionHoistedImport,
  MxRegionPositionCheck as PublicMxRegionPositionCheck,
} from "@mxlang/parser";
import { expectTypeOf, it } from "vitest";
import type { HoistedImport as RealHoistedImport } from "./mx/hoist-imports.ts";
import type {
  MxRegionCompile as RealMxRegionCompile,
  MxRegionCompileInput as RealMxRegionCompileInput,
  MxRegionCompileResult as RealMxRegionCompileResult,
} from "./mx/region-compile.ts";
import type {
  MxRegionContext as RealMxRegionContext,
  MxRegionPositionCheck as RealMxRegionPositionCheck,
} from "./mx/region-context.ts";

/**
 * `public.d.ts` declares every MX region type inline, inside an ambient
 * `declare module` block — a relative import/re-export there is TS2439,
 * which every consumer's `skipLibCheck: true` silently swallows into `any`
 * (see the type's own comment for the measured proof). These assertions pin
 * two-way assignability between each real, computed shape and its public
 * counterpart, so a change to one that the other doesn't follow is a type
 * error here rather than a silent drift discovered by a consumer.
 */

it("keeps public.d.ts's ambient MX region types assignable both ways with the real ones", () => {
  expectTypeOf<PublicMxRegionContext>().toEqualTypeOf<RealMxRegionContext>();
  expectTypeOf<PublicMxRegionPositionCheck>().toEqualTypeOf<RealMxRegionPositionCheck>();
  expectTypeOf<PublicMxRegionHoistedImport>().toEqualTypeOf<RealHoistedImport>();
  expectTypeOf<PublicMxRegionCompileInput>().toEqualTypeOf<RealMxRegionCompileInput>();
  expectTypeOf<PublicMxRegionCompileResult>().toEqualTypeOf<RealMxRegionCompileResult>();
  expectTypeOf<PublicMxRegionCompile>().toEqualTypeOf<RealMxRegionCompile>();
});
