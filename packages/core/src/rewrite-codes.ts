import type { IrNode, Position } from "./ir.ts";

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Position>;
  return (
    typeof candidate.line === "number" && typeof candidate.column === "number"
  );
}

/** Every name a statement-like child declares for the rest of its list. */
function blockDeclaredNames(node: IrNode): string[] {
  if (!node || typeof node !== "object") return [];
  if (node.kind === "Const") {
    return node.varBindings?.map((binding) => binding.name) ?? [node.name];
  }
  if (node.kind === "Define") return [node.name];
  return [];
}

/**
 * The names a record's params bind and which of its keys they cover.
 *
 * Read from the IR's `bindings` (Babel's binding analysis at lowering); a
 * record without the field binds nothing, except a `<define>`, whose params
 * text is still read as names as before. A dynamic tag's (`<${X}|a|>`,
 * `<try>`) params cover its body only, never its attributes; an
 * attribute-tag `<for>`'s cover its `nodes`.
 */
function boundScope(
  record: Record<string, unknown>,
): { names: readonly string[]; covers: (key: string) => boolean } | null {
  const node = record as unknown as IrNode;
  if (node.kind === "For") {
    return { names: node.bindings, covers: (key) => key !== "source" };
  }
  if (node.kind === "Define") {
    // A `<define>`'s attributes are written outside its params' scope.
    return {
      names: node.bindings ?? node.params,
      covers: (key) => key !== "attrs",
    };
  }
  if (
    (node as { kind?: string }).kind === "AttributeTagFor" &&
    record.loop &&
    typeof record.loop === "object"
  ) {
    const loop = record.loop as { bindings?: string[] };
    return { names: loop.bindings ?? [], covers: (key) => key === "nodes" };
  }
  if (typeof record.hasParams === "boolean" && Array.isArray(record.children)) {
    const bindings = record.bindings;
    return {
      names: Array.isArray(bindings) ? (bindings as string[]) : [],
      covers: () => true,
    };
  }
  return null;
}

/**
 * A record's entries with `attributeTagTree` first. An attribute tag's node is
 * shared by the flat `attributeTags` list and the tree, and each node is
 * visited once, at the first place reached: only the tree knows the
 * attribute-tag `<for>` scope around it, so it is walked first.
 */
function treeFirst(record: Record<string, unknown>): [string, unknown][] {
  const entries = Object.entries(record);
  if (!("attributeTagTree" in record)) return entries;
  return [
    ["attributeTagTree", record.attributeTagTree],
    ...entries.filter(([key]) => key !== "attributeTagTree"),
  ];
}

/** Applies one expression rewrite across an IR tree while preserving scope. */
export function rewriteCodes(
  nodes: unknown,
  rewrite: (
    code: string,
    loc: Position,
    shadowed: ReadonlySet<string>,
  ) => string,
): void {
  const seen = new Set<object>();
  const visit = (
    value: unknown,
    loc: Position,
    shadowed: ReadonlySet<string>,
  ): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      let scope = shadowed;
      for (const item of value) {
        visit(item, loc, scope);
        const declared = blockDeclaredNames(item as IrNode).filter(
          (name) => !scope.has(name),
        );
        if (declared.length > 0) scope = new Set([...scope, ...declared]);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const here = isPosition(record.loc) ? record.loc : loc;
    if (typeof record.code === "string" && "shape" in record) {
      const before = record.code;
      record.code = rewrite(before, here, shadowed);
      if (record.code !== before) record.unrewrittenCode ??= before;
      return;
    }

    const scope = boundScope(record);
    const inner =
      scope && scope.names.length > 0
        ? new Set([...shadowed, ...scope.names])
        : shadowed;
    // A dynamic tag's params bind inside `tag.children` only.
    const tag =
      record.kind === "DelegatedTag" &&
      record.tag &&
      typeof record.tag === "object"
        ? (record.tag as Record<string, unknown>)
        : null;
    const tagBindings = Array.isArray(tag?.bindings)
      ? (tag.bindings as string[])
      : [];
    for (const [key, child] of treeFirst(record)) {
      if (key === "node") continue;
      if (key === "tag" && tag && tagBindings.length > 0) {
        if (seen.has(tag)) continue;
        seen.add(tag);
        const body = new Set([...shadowed, ...tagBindings]);
        const tagHere = isPosition(tag.loc) ? tag.loc : here;
        for (const [tagKey, tagChild] of treeFirst(tag)) {
          if (tagKey === "node") continue;
          visit(tagChild, tagHere, tagKey === "children" ? body : shadowed);
        }
        continue;
      }
      visit(child, here, scope?.covers(key) ? inner : shadowed);
    }
  };
  visit(nodes, { line: 0, column: 0 }, new Set());
}
