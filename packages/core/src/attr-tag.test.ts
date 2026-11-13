import { expectTypeOf, it } from "vitest";
import type {
  AttrTag,
  AttrTagAttrs,
  AttrTagConfig,
  AttrTagOf,
  AttrTagParams,
} from "./attr-tag.ts";

/**
 * `Marko.AttrTag<T>` exactly as `marko` 6.4.4 declares it (`index.d.ts`, the
 * global `Marko` namespace). Core does not depend on `marko`, so the type is
 * copied here; a Marko bump that changes it must change this copy.
 */
type MarkoAttrTag<T> = T & {
  [Symbol.iterator](): Iterator<T>;
};

type Item = { a: number; content?: () => string };

it("types the record as the first occurrence plus the iteration members", () => {
  expectTypeOf<AttrTag<Item>>().toEqualTypeOf<
    Item & {
      [Symbol.iterator](): Iterator<Item>;
      readonly length: number;
      at(index: number): Item | undefined;
      map<U>(fn: (item: Item, index: number) => U): U[];
      filter(fn: (item: Item, index: number) => unknown): Item[];
      toArray(): Item[];
    }
  >();
});

it("is assignable to Marko's AttrTag<T>", () => {
  expectTypeOf<AttrTag<Item>>().toMatchTypeOf<MarkoAttrTag<Item>>();
  // biome-ignore lint/complexity/noBannedTypes: the default, an attribute tag with no attributes
  expectTypeOf<AttrTag>().toMatchTypeOf<MarkoAttrTag<{}>>();
  // Marko's record lacks the prototype members, so it is not an MX record.
  expectTypeOf<MarkoAttrTag<Item>>().not.toMatchTypeOf<AttrTag<Item>>();
});

it("keeps the deprecated config form exported and unchanged", () => {
  expectTypeOf<
    AttrTagOf<{ attrs: { title: string }; params: [count: number] }, string>
  >().toEqualTypeOf<
    { title: string } & { content?: (count: number) => string }
  >();
  expectTypeOf<AttrTagParams<{ params: [id: number] }>>().toEqualTypeOf<
    [id: number]
  >();
  expectTypeOf<AttrTagAttrs<{ attrs: { title: string } }>>().toEqualTypeOf<{
    title: string;
  }>();
  expectTypeOf<{ as: "data" }>().toMatchTypeOf<AttrTagConfig>();
});
