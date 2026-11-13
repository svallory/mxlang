import { describe, expect, it } from "vitest";
import type { AttrTag } from "./index.ts";

type Item = { id: number };
const one = { id: 1, content: () => "one" };
const two = { id: 2 };
const items = [one, two];
const record = Object.assign(Object.create(null), one, {
  [Symbol.iterator]: () => items[Symbol.iterator](),
  length: 2,
  at: (index: number) => items.at(index),
  map: <U>(fn: (item: Item, index: number) => U) => items.map(fn),
  filter: (fn: (item: Item, index: number) => unknown) => items.filter(fn),
  toArray: () => items,
});

const data: AttrTag<Item> = record;
const parameterized: AttrTag<{ content: (label: string) => () => string }> =
  Object.assign(Object.create(null), {
    content: (label: string) => () => label,
  });

describe("Solid AttrTag type", () => {
  it("adds an accessor as content unless the occurrence declares one", () => {
    expect(data.content?.()).toBe("one");
    expect(data.map((item) => item.id)).toEqual([1, 2]);
    expect(parameterized.content("two")()).toBe("two");
  });
});
