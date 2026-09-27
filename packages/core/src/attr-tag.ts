import type { AttributeTag, AttributeTagNode, AttrTagProp } from "./ir.ts";

/**
 * Decision 108's shape for a property on an untyped or unresolved callee.
 * One attributed occurrence makes every occurrence data-shaped so the prop
 * has one stable value shape across branches and loops.
 */
export function fallbackAttrTagShape(
  tags: readonly AttributeTag[],
  name: string,
): "data" | "renderable" {
  return tags.some(
    (tag) =>
      tag.name === name &&
      (tag.attrs.length > 0 || tag.attributeTags.length > 0),
  )
    ? "data"
    : "renderable";
}

function occurrenceRange(
  nodes: readonly AttributeTagNode[],
  name: string,
): { max: number; inFor: boolean } {
  let max = 0;
  let inFor = false;
  for (const node of nodes) {
    if (node.kind === "AttributeTag") {
      if (node.tag.name === name) max++;
      continue;
    }
    if (node.kind === "AttributeTagFor") {
      const inner = occurrenceRange(node.nodes, name);
      if (inner.max > 0) {
        max = Number.POSITIVE_INFINITY;
        inFor = true;
      }
      continue;
    }
    const ranges = node.branches.map((branch) =>
      occurrenceRange(branch.nodes, name),
    );
    max += Math.max(0, ...ranges.map((range) => range.max));
    inFor ||= ranges.some((range) => range.inFor);
  }
  return { max, inFor };
}

function filterTree(
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
        nodes: filterTree(branch.nodes, name),
      }));
      if (branches.some((branch) => branch.nodes.length > 0)) {
        filtered.push({ ...node, branches });
      }
      continue;
    }
    const nested = filterTree(node.nodes, name);
    if (nested.length > 0) filtered.push({ ...node, nodes: nested });
  }
  return filtered;
}

/**
 * Gives every occurrence of one parent property the same nested value shapes.
 * The walk recurses by nested property name, so the invariant holds at every
 * depth rather than only for direct children.
 */
export function unifyNestedAttrTagPlans(
  parents: readonly AttributeTag[],
): void {
  const children = parents.flatMap((parent) => parent.attributeTags);
  const groups = new Map<string, AttributeTag[]>();
  for (const child of children) {
    const group = groups.get(child.name);
    if (group) group.push(child);
    else groups.set(child.name, [child]);
  }
  for (const group of groups.values()) unifyNestedAttrTagPlans(group);

  const names = [...groups.keys()];
  for (const parent of parents) {
    for (const prop of parent.attrTagProps) {
      if (prop.declared && !names.includes(prop.name)) names.push(prop.name);
    }
  }

  const unified = new Map<
    string,
    Pick<AttrTagProp, "cardinality" | "as"> & { isDeclared: boolean }
  >();
  for (const name of names) {
    const declared = parents
      .flatMap((parent) => parent.attrTagProps)
      .find((prop) => prop.name === name && prop.declared);
    const fallbackCardinality = parents.some((parent) => {
      const range = occurrenceRange(parent.attributeTagTree, name);
      return range.max > 1 || range.inFor;
    })
      ? "array"
      : "single";
    unified.set(name, {
      cardinality: declared?.cardinality ?? fallbackCardinality,
      as: declared?.as ?? fallbackAttrTagShape(children, name),
      isDeclared: declared !== undefined,
    });
  }

  for (const parent of parents) {
    parent.attrTagProps = names.map((name) => {
      const shape = unified.get(name) as Pick<
        AttrTagProp,
        "cardinality" | "as"
      > & { isDeclared: boolean };
      const prop: AttrTagProp = {
        name,
        cardinality: shape.cardinality,
        as: shape.as,
        source: filterTree(parent.attributeTagTree, name),
      };
      if (shape.isDeclared) {
        Object.defineProperty(prop, "declared", { value: true });
      }
      return prop;
    });
  }
}

/**
 * Unifies nested plans only among occurrences of the same parent property.
 * Sibling properties are independent contracts even when their nested tag
 * names happen to overlap.
 */
export function unifyNestedAttrTagPlanGroups(
  parents: readonly AttributeTag[],
): void {
  const groups = new Map<string, AttributeTag[]>();
  for (const parent of parents) {
    const group = groups.get(parent.name);
    if (group) group.push(parent);
    else groups.set(parent.name, [parent]);
  }
  for (const group of groups.values()) unifyNestedAttrTagPlans(group);
}

export interface AttrTagConfig {
  as?: "data" | "renderable";
  attrs?: object;
  params?: readonly unknown[];
}

export type AttrTagParams<C extends AttrTagConfig> =
  C["params"] extends readonly unknown[] ? C["params"] : [];

export type AttrTagAttrs<C extends AttrTagConfig> =
  // biome-ignore lint/complexity/noBannedTypes: the public contract intentionally means an object with no required attributes
  C["attrs"] extends object ? C["attrs"] : {};

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

export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: matches the public AttrTag default from decision 106
  C extends AttrTagConfig = {},
> = AttrTagOf<C, unknown>;
