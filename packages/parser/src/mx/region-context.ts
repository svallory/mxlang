/**
 * Generic "enclosing syntax" signal for an MX region, computed purely from
 * the parser's own syntactic state — no host (Angular, etc.) knowledge here.
 * A host supplies `MxRegionPositionCheck` through the `mxRegionPositionCheck`
 * parser option (beside `mxCustomTags`, `bridge.ts:83-86`) to veto a region
 * that appears somewhere it does not support.
 */

/** Where a region appeared, described without host-specific knowledge. */
export interface MxRegionContext {
  /** Innermost enclosing object-property key, if any: `template` in
   *  `@Component({ template: <div/> })`, and in `{ x: { template: <region/> } }`
   *  too (innermost, not `x`). Null in any other position, or when the region
   *  sits inside a spread rather than a named property. */
  propertyKey: string | null;
  /** Names of every enclosing decorator, innermost first. In practice this
   *  is at most one entry — a decorator attaches to a declaration, not to an
   *  arbitrary expression, so JS syntax has no way to write a second real
   *  `@decorator` whose own argument nests inside a first one's (`Inner(...)`
   *  inside `@Outer(Inner(...))`'s argument is an ordinary call, not a
   *  decorator). The list shape is kept general rather than narrowed to
   *  `string | null` on the chance a future syntax proposal changes that.
   *  Empty when the region is not inside any decorator call. */
  decoratorNames: readonly string[];
  /** The index of the decorator-call argument that (transitively) encloses
   *  the region, or `null` when the region isn't inside any decorator's
   *  argument list at all. `@Component({ template: <div/> })` (the
   *  canonical, single-argument shape) is `0`;
   *  `@Component(opts, { template: <div/> })` is `1` — a distinction
   *  `propertyKey`/`isDirectPropertyValue` alone can't make, since both
   *  shapes otherwise look identical to them. */
  argumentIndex: number | null;
  /** True iff the region is the immediate value of a property of the
   *  decorator argument object itself.
   *
   *  Every frame from the enclosing decorator (or the start of the stack, if
   *  none) up to and including the property directly enclosing the region
   *  must be an unbroken, unwrapped chain: each `boundary` frame in that
   *  span (the decorator's own call-argument slot, the object literal's own
   *  braces, …) must share the exact same `valueStart` — the offset where
   *  its own construct began — because nothing but whitespace may separate
   *  "the decorator's sole argument" from "the object literal that argument
   *  is," and the final `property` frame's `valueStart` must equal the
   *  region's own start. Any wrapper that shifts one of those offsets away
   *  from the others breaks the chain and makes this `false`:
   *  `@Component(wrap({ template: <div/> }))` (the `wrap(...)` call sits
   *  between the decorator's argument slot and the object), `@Component(c ?
   *  { template: <div/> } : y)` (the ternary condition does), and
   *  `@Component([{ template: <div/> }])` (the array does) are all `false`,
   *  even though each one's `template` property is itself an exact,
   *  unwrapped match one level down — a boundary opened *before* the first
   *  property frame in the chain always breaks it, regardless of what
   *  happens deeper in. `{ x: { template: <region/> } }` is `false` for the
   *  same reason: `x` is the property directly enclosing the region's
   *  ultimate ancestor object, and the region does not start at `x`'s own
   *  value — even though `propertyKey` reports the innermost `"template"`.
   *  An exact-position test, not a shape heuristic: no wrapper shape
   *  (ternary, parenthesized, arrow body, spread, a further-nested object,
   *  …) needs to be enumerated one by one. */
  isDirectPropertyValue: boolean;
}

/** A host's veto on a region's syntactic position. */
export type MxRegionPositionCheck = (
  context: MxRegionContext,
) => { ok: true } | { ok: false; message: string };

/**
 * One frame of the minimal parent stack the parser instruments while
 * `mxRegionPositionCheck` is set. The tokenizer's own `context: TokContext[]`
 * (`tokenizer/state.ts`) is brace/template disambiguation, not a syntactic
 * parent path, so this is tracked separately and only when a host asked for
 * it — see `bridge.ts:83-86`'s options-bag channel and the design note at
 * `notes/investigations/angular-ng-mx-spike.md` §Q4.
 */
export type MxRegionParentFrame =
  | {
      kind: "property";
      /**
       * The property's own key, or `null` for a spread element's operand
       * (`...expr` inside an object literal) — a spread has no key to
       * report, but its operand still opens exactly the same kind of nested
       * value position a named property's value does, and `isDirectPropertyValue`
       * needs to see it to tell `{ template: <div/> }` (direct) apart from
       * `{ ...{ template: <div/> } }` (not: the region sits one object
       * literal deeper than the one directly inside the decorator's own
       * call argument).
       */
      key: string | null;
      /**
       * The absolute source offset where this property's (or spread's)
       * value expression began being parsed (`parseObjectProperty`, right
       * after eating the `:` or the `...`). `isDirectPropertyValue` compares
       * the region's own start against the **outermost** such frame's
       * `valueStart` — an exact-position test, so any wrapper between that
       * frame's value-start and the region (a ternary, a parenthesized
       * expression, `${...}`, an arrow body, `||`, an assignment, a sequence
       * expression, a further-nested object/spread/property, …) makes it
       * false, with no need to enumerate wrapper shapes one by one.
       */
      valueStart: number;
    }
  | { kind: "decorator"; name: string }
  /**
   * Any other value-producing construct: an object literal's braces
   * (`parseObjectLike`), or one item of a call-argument/array list
   * (`parseExprListItem`, the single choke point both share).
   * `propertyKey`/`decoratorNames` ignore these entirely, but
   * `isDirectPropertyValue` reads their `valueStart` too — see its own doc
   * comment on `MxRegionContext` for why a `boundary`'s own start offset
   * (not just its presence) is what tells "the decorator's sole argument is
   * this exact object literal" apart from "something else wraps it."
   * `argumentIndex` is non-null only for a `parseExprListItem` boundary that
   * is itself one of a decorator's own top-level call arguments — `null` for
   * an object literal's own braces (`parseObjectLike`) and for any nested
   * list item (an array element, a call argument two levels deep, …), which
   * have no bearing on `MxRegionContext.argumentIndex`.
   */
  | { kind: "boundary"; valueStart: number; argumentIndex: number | null };

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
 * `decoratorNames` lists every enclosing decorator, innermost first — see
 * the `MxRegionContext` field's own doc comment for why this is at most one
 * entry in practice. `isDirectPropertyValue` walks the frames after the
 * innermost decorator (or from the start of the stack, if none) while they
 * are `boundary` frames sharing one common `valueStart` — the first frame's
 * own — then requires the frame right after that run to be a `property`
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
  const decoratorNames: string[] = [];
  let innermostDecoratorIndex = -1;

  for (let i = 0; i < stack.length; i++) {
    const frame = stack[i];
    if (frame === undefined) continue;
    if (frame.kind === "property") {
      // Innermost named key wins for reporting: `{ x: { template: <region/> } }`
      // reports "template", not "x".
      if (frame.key !== null) propertyKey = frame.key;
    } else if (frame.kind === "decorator") {
      decoratorNames.unshift(frame.name);
      innermostDecoratorIndex = i;
    }
  }

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

  return { propertyKey, decoratorNames, isDirectPropertyValue, argumentIndex };
}

/**
 * Reads a static property-key name off an already-parsed, non-computed
 * `ObjectProperty` key node (`Identifier`, `StringLiteral`, `NumericLiteral`).
 * Null for a computed key or any other key shape, in which case the property
 * contributes no `propertyKey`/direct-value frame — a host's check simply
 * sees an unrelated position, matching a non-decorator call's own shape.
 */
export function mxPropertyKeyName(
  computed: boolean,
  key: { type: string; name?: string; value?: unknown },
): string | null {
  if (computed) return null;
  if (key.type === "Identifier" && typeof key.name === "string") {
    return key.name;
  }
  if (
    (key.type === "StringLiteral" || key.type === "NumericLiteral") &&
    typeof key.value !== "undefined"
  ) {
    return String(key.value);
  }
  return null;
}

/**
 * Reads a decorator's own name off its (possibly call-wrapped) expression:
 * `Component` from either `@Component` or `@Component(...)`, and the final
 * property name from a member expression (`@ns.Component`). `unknown`-typed
 * because callers pass Babel expression node unions this module has no
 * dependency on; anything else (a computed member, a non-identifier callee)
 * yields null, contributing no `decorator` frame.
 */
export function decoratorNameFromExpression(expr: unknown): string | null {
  const node = expr as
    | { type?: unknown; callee?: unknown; name?: unknown; property?: unknown }
    | null
    | undefined;
  if (!node || typeof node.type !== "string") return null;
  const target =
    node.type === "CallExpression"
      ? (node.callee as typeof node | undefined)
      : node;
  if (!target || typeof target.type !== "string") return null;
  if (target.type === "Identifier") {
    return typeof target.name === "string" ? target.name : null;
  }
  if (target.type === "MemberExpression") {
    const property = target.property as { name?: unknown } | undefined;
    return typeof property?.name === "string" ? property.name : null;
  }
  return null;
}
