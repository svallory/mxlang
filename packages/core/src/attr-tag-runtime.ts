/**
 * The attribute-tag record every value target hands a callee (spec §8,
 * "Attribute tags: `<@name>`").
 *
 * The record is Marko 6.4.4's (`@marko/runtime-tags`, `attrTag`/`attrTags`):
 * the first occurrence is the object itself, with an own `[Symbol.iterator]`
 * and an own hidden `rest` array holding every later occurrence. On top of
 * Marko's record MX sets one prototype, so the record also answers `map`,
 * `filter`, `length`, `at` and `toArray`. Own properties are Marko's exactly;
 * the prototype members are non-enumerable, so a spread or `JSON.stringify`
 * never sees them.
 *
 * MX ships no runtime package, so this is TypeScript source text: each value
 * host appends it once to a module that builds a record, and calls
 * {@link ATTR_TAG_RECORD} (`__mxAttrTag`) for an occurrence that is alone and
 * unconditional, {@link ATTR_TAG_FOLD} (`__mxAttrTags`) for each step of a fold
 * that starts from `undefined`. Every name it declares starts with the
 * reserved `__mx`/`__Mx` prefix.
 */

/** The function that makes one occurrence a record: Marko's `attrTag`. */
export const ATTR_TAG_RECORD = "__mxAttrTag";

/** The fold step over occurrences: Marko's `attrTags(first, attrs)`. */
export const ATTR_TAG_FOLD = "__mxAttrTags";

/**
 * The helper, as module-level TypeScript declarations. `__MxAttrTag<T>` is the
 * record's type, the same shape as `AttrTag<T>`, declared here because emitted
 * code imports no MX package.
 *
 * `__mxAttrTag` takes `T` from where its result goes (the callee's declared
 * prop), never from its argument (`NoInfer`): the occurrence object is then
 * checked against the declared attributes, so a wrong attribute is reported
 * at that attribute and a body's params get their declared types. With no
 * declared type `T` is `{}` and any object is accepted. `T` has no `object`
 * constraint: an optional prop gives the contextual type `X | undefined`, and
 * under a constraint TypeScript infers `object` from it instead of `X` (a
 * weak `X`, all-optional like Astro's data `AttrTag`, then rejects the
 * record); unconstrained it infers `X | undefined`, and the mapped type
 * drops the `undefined`. A fold step
 * (`__mxAttrTags`) sits in a statement with no declared type, so it infers
 * from its argument.
 */
export const ATTR_TAG_RUNTIME = `type __MxAttrTag<T> = T & { [Symbol.iterator](): Iterator<T>; readonly length: number; at(index: number): T | undefined; map<U>(fn: (item: T, index: number) => U): U[]; filter(fn: (item: T, index: number) => unknown): T[]; toArray(): T[] };
type __MxAttrTagMember = typeof Symbol.iterator | "length" | "at" | "map" | "filter" | "toArray";
const __mxAttrTagEmpty: never[] = [];
const __mxAttrTagRest = Symbol("Attribute Tag");
const __mxAttrTagProto = Object.create(Object.prototype, {
  length: { get(this: any): number { return 1 + this[__mxAttrTagRest].length; } },
  toArray: { value(this: any): any[] { return [this, ...this[__mxAttrTagRest]]; } },
  at: {
    value(this: any, index: number): any {
      const all = [this, ...this[__mxAttrTagRest]];
      const at = Math.trunc(index) || 0;
      return all[at < 0 ? at + all.length : at];
    },
  },
  map: { value(this: any, fn: (item: any, index: number) => any): any[] { return [this, ...this[__mxAttrTagRest]].map((item, index) => fn(item, index)); } },
  filter: { value(this: any, fn: (item: any, index: number) => unknown): any[] { return [this, ...this[__mxAttrTagRest]].filter((item, index) => fn(item, index)); } },
});
function* __mxAttrTagIterator(this: any): Generator<any> {
  yield this;
  yield* this[__mxAttrTagRest];
}
function ${ATTR_TAG_RECORD}<T = {}>(attrs: NoInfer<{ [K in keyof T as K extends __MxAttrTagMember ? never : K]: T[K] }>): __MxAttrTag<T> {
  (attrs as any)[Symbol.iterator] = __mxAttrTagIterator;
  (attrs as any)[__mxAttrTagRest] = __mxAttrTagEmpty;
  return Object.setPrototypeOf(attrs, __mxAttrTagProto);
}
function ${ATTR_TAG_FOLD}<A extends object | undefined, T extends object>(first: A, attrs: T): __MxAttrTag<T | (A extends __MxAttrTag<infer U> ? U : never)> {
  if (first) {
    const record: any = first;
    if (record[__mxAttrTagRest] === __mxAttrTagEmpty) record[__mxAttrTagRest] = [attrs];
    else record[__mxAttrTagRest].push(attrs);
    return record;
  }
  return ${ATTR_TAG_RECORD}(attrs) as any;
}`;

/** Does emitted module text call the helper (and so need it appended)? */
export function usesAttrTagRuntime(code: string): boolean {
  return (
    code.includes(`${ATTR_TAG_RECORD}(`) || code.includes(`${ATTR_TAG_FOLD}(`)
  );
}
