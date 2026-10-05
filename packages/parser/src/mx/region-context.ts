/**
 * Generic "enclosing syntax" signal for an MX region, computed purely from
 * the parser's own syntactic state — no host (Angular, etc.) knowledge here.
 * A host supplies `MxRegionPositionCheck` through the `mxRegionPositionCheck`
 * parser option (beside `mxCustomTags`, `bridge.ts:83-86`) to veto a region
 * that appears somewhere it does not support.
 */

import type { MxRegionContext, MxRegionParentFrame } from "../babel/index.ts";

export type {
  MxRegionContext,
  MxRegionParentFrame,
  MxRegionPositionCheck,
} from "../babel/index.ts";

/**
 * Computes the `MxRegionContext` for a region about to start, from the
 * parent-frame stack built up by `parseObjectProperty`,
 * `parseMaybeDecoratorArguments`, `parseExprListItem`, `parseObjectLike` and
 * the object-spread branch of `parsePropertyDefinition`'s push/pop calls
 * (`../babel/parser/expression.ts`, `../babel/parser/statement.ts`), plus
 * the region's own start offset.
 *
 * `propertyKey` reads the innermost `property` frame that has a real key
 * (skipping spread frames, which carry `key: null`) — this scans the whole
 * stack and is independent of `isDirectPropertyValue`'s narrower chain-walk.
 * `decoratorNames` reports only the innermost enclosing decorator (`[]` when
 * none), scoped to match `propertyKey`/`isDirectPropertyValue`/
 * `argumentIndex`; every other enclosing decorator, outermost first, goes in
 * `enclosingDecoratorNames` instead — see the `MxRegionContext` field's own
 * doc comment for why nesting is possible at all. `isDirectPropertyValue`
 * walks the frames after the innermost decorator (or from the start of the
 * stack, if none) while they are `boundary` frames sharing one common
 * `valueStart` — the first frame's own — then requires the frame right
 * after that run to be a `property`
 * whose `valueStart` equals the region's own start. Any `boundary` whose
 * `valueStart` breaks from the chain (a call, a ternary branch, an array,
 * …) makes the whole thing `false`, without inspecting anything past it —
 * see the `MxRegionContext` field's own doc comment for the worked examples.
 */
export function computeMxRegionContext(
  stack: readonly MxRegionParentFrame[],
  regionStart: number,
): MxRegionContext {
  let propertyKey: string | null = null;
  const enclosingDecoratorNames: string[] = [];
  let innermostDecoratorName: string | null = null;
  let innermostDecoratorIndex = -1;

  for (let i = 0; i < stack.length; i++) {
    const frame = stack[i];
    if (frame === undefined) continue;
    if (frame.kind === "property") {
      // Innermost named key wins for reporting: `{ x: { template: <region/> } }`
      // reports "template", not "x".
      if (frame.key !== null) propertyKey = frame.key;
    } else if (frame.kind === "decorator") {
      // The stack walks outer-to-inner, so the previous innermost decorator
      // (if any) becomes an enclosing one once a later, more-inner decorator
      // frame is found.
      if (innermostDecoratorName !== null) {
        enclosingDecoratorNames.push(innermostDecoratorName);
      }
      innermostDecoratorName = frame.name;
      innermostDecoratorIndex = i;
    }
  }
  const decoratorNames: string[] =
    innermostDecoratorName !== null ? [innermostDecoratorName] : [];

  let isDirectPropertyValue = false;
  let argumentIndex: number | null = null;
  const first = stack[innermostDecoratorIndex + 1];
  if (first !== undefined && first.kind !== "decorator") {
    // Only a `boundary` frame carries an `argumentIndex` at all, and only
    // when it's itself a decorator's own top-level list item (see the
    // `MxRegionParentFrame` "boundary" doc comment) — `first` is exactly
    // that frame whenever a decorator encloses the region.
    if (innermostDecoratorIndex !== -1 && first.kind === "boundary") {
      argumentIndex = first.argumentIndex;
    }

    const chainStart = first.valueStart;
    let i = innermostDecoratorIndex + 1;
    let frame = stack[i];
    while (
      frame !== undefined &&
      frame.kind === "boundary" &&
      frame.valueStart === chainStart
    ) {
      i++;
      frame = stack[i];
    }
    isDirectPropertyValue =
      frame !== undefined &&
      frame.kind === "property" &&
      regionStart === frame.valueStart;
  }

  return {
    propertyKey,
    decoratorNames,
    enclosingDecoratorNames,
    isDirectPropertyValue,
    argumentIndex,
  };
}
