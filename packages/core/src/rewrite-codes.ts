import type { IrNode, Position } from "./ir.ts";

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Position>;
  return (
    typeof candidate.line === "number" && typeof candidate.column === "number"
  );
}

function blockDeclaredName(node: IrNode): string | null {
  if (node.kind === "Const" || node.kind === "Define") return node.name;
  return null;
}

function irBoundNames(node: IrNode): string[] {
  if (node.kind === "For") return node.bindings;
  if (node.kind === "Define") return node.params;
  return [];
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
        const declared = blockDeclaredName(item as IrNode);
        if (declared && !scope.has(declared)) {
          scope = new Set<string>([...scope, declared]);
        }
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const here = isPosition(record.loc) ? record.loc : loc;
    if (typeof record.code === "string" && "shape" in record) {
      record.code = rewrite(record.code, here, shadowed);
      return;
    }

    const bound = irBoundNames(record as unknown as IrNode);
    const inner =
      bound.length === 0 ? shadowed : new Set([...shadowed, ...bound]);
    for (const [key, child] of Object.entries(record)) {
      if (key === "node") continue;
      visit(child, here, key === "source" ? shadowed : inner);
    }
  };
  visit(nodes, { line: 0, column: 0 }, new Set());
}
