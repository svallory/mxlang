/** Remove rejected owners, including every synchronized view of a tag. */
import type { Ir } from "../ir.ts";

export function omitRejected(ir: Ir, rejected: ReadonlySet<object>): void {
  // Components cannot be interpreted by this entry; their generated imports
  // have no authored spans and must not leak into the recovered SpannedIr.
  ir.imports = ir.imports.filter((node) => !node.synthesized);
  const seen = new Set<object>();
  const omitted = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    return (
      rejected.has(value) ||
      ("tag" in value && rejected.has(value.tag as object))
    );
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        if (omitted(value[i])) value.splice(i, 1);
      }
      for (const child of value) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      // Babel/dialect nodes and opaque host data are not IR containers.
      if (
        key === "node" ||
        key === "paramNodes" ||
        key === "data" ||
        key === "forward"
      )
        continue;
      visit(child);
    }
  };
  if (ir.inputInterface && rejected.has(ir.inputInterface))
    ir.inputInterface = null;
  visit(ir);
}
