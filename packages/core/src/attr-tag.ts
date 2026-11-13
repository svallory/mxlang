import type { AttributeTagNode } from "./ir.ts";

/**
 * The occurrences of one attribute-tag name in a tree, with the `<if>` and
 * `<for>` around them kept and every other name dropped. A value host folds
 * the result, in order, into the name's record (spec §8).
 */
export function filterAttributeTagTree(
  nodes: readonly AttributeTagNode[],
  name: string,
): AttributeTagNode[] {
  const filtered: AttributeTagNode[] = [];
  for (const node of nodes) {
    if (node.kind === "AttributeTag") {
      if (node.tag.name === name) filtered.push(node);
      continue;
    }
    if (node.kind === "AttributeTagIf") {
      const branches = node.branches.map((branch) => ({
        ...branch,
        nodes: filterAttributeTagTree(branch.nodes, name),
      }));
      if (branches.some((branch) => branch.nodes.length > 0)) {
        filtered.push({ ...node, branches });
      }
      continue;
    }
    const nested = filterAttributeTagTree(node.nodes, name);
    if (nested.length > 0) filtered.push({ ...node, nodes: nested });
  }
  return filtered;
}

/** Every attribute-tag name in a tree, in order of its first occurrence. */
export function attributeTagNames(
  nodes: readonly AttributeTagNode[],
): string[] {
  const names: string[] = [];
  const walk = (list: readonly AttributeTagNode[]): void => {
    for (const node of list) {
      if (node.kind === "AttributeTag") {
        if (!names.includes(node.tag.name)) names.push(node.tag.name);
      } else if (node.kind === "AttributeTagIf") {
        for (const branch of node.branches) walk(branch.nodes);
      } else walk(node.nodes);
    }
  };
  walk(nodes);
  return names;
}

/**
 * The value a callee receives for `<@name>`: the first occurrence, carrying
 * every later one (Marko's record), with `map`, `filter`, `length`, `at` and
 * `toArray` on its prototype (spec §8). Assignable to Marko's `AttrTag<T>`.
 */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: an attribute tag with no declared attributes
  T extends object = {},
> = T & {
  [Symbol.iterator](): Iterator<T>;
  readonly length: number;
  at(index: number): T | undefined;
  map<U>(fn: (item: T, index: number) => U): U[];
  filter(fn: (item: T, index: number) => unknown): T[];
  toArray(): T[];
};

/**
 * @deprecated The config form of `AttrTag` no longer shapes anything: every
 * attribute tag is a record (`AttrTag<T>`). Unused by MX.
 */
export interface AttrTagConfig {
  as?: "data" | "renderable";
  attrs?: object;
  params?: readonly unknown[];
}

/** @deprecated See {@link AttrTagConfig}. Unused by MX. */
export type AttrTagParams<C extends AttrTagConfig> =
  C["params"] extends readonly unknown[] ? C["params"] : [];

/** @deprecated See {@link AttrTagConfig}. Unused by MX. */
export type AttrTagAttrs<C extends AttrTagConfig> =
  // biome-ignore lint/complexity/noBannedTypes: the public contract intentionally means an object with no required attributes
  C["attrs"] extends object ? C["attrs"] : {};

/** @deprecated See {@link AttrTagConfig}. Unused by MX. */
export type AttrTagOf<C extends AttrTagConfig, R> = C["as"] extends "renderable"
  ? C["params"] extends readonly unknown[]
    ? (...args: C["params"]) => R
    : R
  : // biome-ignore lint/complexity/noBannedTypes: the public contract intentionally means any non-nullish empty config
    (C["attrs"] extends object ? C["attrs"] : {}) & {
      content?: C["params"] extends readonly unknown[]
        ? (...args: C["params"]) => R
        : R;
    };
