import type { NgtscProgram } from "@angular/compiler-cli";
import type ts from "typescript";
import type { Diagnostic } from "./types.ts";

type TemplateChecker = ReturnType<
  NgtscProgram["compiler"]["getTemplateTypeChecker"]
>;
type ElementNode = Parameters<TemplateChecker["getDirectivesOfNode"]>[1];

/** Adjacent transpositions count as one edit; ties never produce advice. */
function nearestInput(
  name: string,
  candidates: readonly string[],
): string | undefined {
  if (name.length < 3) return undefined;
  let best: string | undefined;
  const limit = name.length >= 5 ? 2 : 1;
  let score = limit + 1;
  let tied = false;
  for (const candidate of new Set(candidates)) {
    if (candidate === name || Math.abs(candidate.length - name.length) > limit)
      continue;
    const a = name.toLowerCase();
    const b = candidate.toLowerCase();
    const rows = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) =>
        i === 0 ? j : j === 0 ? i : 0,
      ),
    );
    // Every grid cell is allocated above, and the loop bounds keep reads inside it.
    for (let i = 1; i <= a.length; i++) {
      const row = rows[i] as number[];
      const above = rows[i - 1] as number[];
      for (let j = 1; j <= b.length; j++) {
        let d = Math.min(
          (above[j] as number) + 1,
          (row[j - 1] as number) + 1,
          (above[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d = Math.min(d, ((rows[i - 2] as number[])[j - 2] as number) + 1);
        }
        row[j] = d;
      }
    }
    const d = (rows[a.length] as number[])[b.length] as number;
    if (d < score) {
      best = candidate;
      score = d;
      tied = false;
    } else if (d === score && best !== undefined) tied = true;
  }
  return tied ? undefined : best;
}

/**
 * Enrich only NG8002 bindings on a resolved component. Angular's matched,
 * flattened input metadata handles aliases, inheritance and signal inputs;
 * unrelated classes and DOM properties are never candidates. No new errors
 * or positions, and Angular's original advice survives when there is no
 * uniquely nearest input.
 */
export function addInputHints(
  program: NgtscProgram,
  entry: ts.SourceFile,
  records: Diagnostic[],
  tsModule: typeof ts,
): Diagnostic[] {
  if (!records.some((d) => d.code === -998002 && d.file === entry.fileName))
    return records;
  const checker = program.compiler.getTemplateTypeChecker();
  const hints = new Map<number, string>();

  function walk(component: ts.ClassDeclaration, value: unknown): void {
    if (Array.isArray(value)) {
      for (const node of value) walk(component, node);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (
      typeof node.name === "string" &&
      Array.isArray(node.inputs) &&
      Array.isArray(node.attributes)
    ) {
      const element = value as ElementNode;
      const components =
        checker
          .getDirectivesOfNode(component, element)
          ?.filter((d) => d.isComponent) ?? [];
      const [matched] = components;
      if (components.length === 1 && matched) {
        const inputs = matched.inputs.propertyNames;
        for (const binding of element.inputs) {
          const near = nearestInput(binding.name, inputs);
          if (near) hints.set(binding.sourceSpan.start.offset, near);
        }
      }
    }
    // Only template containers, never arbitrary AST objects (which may have
    // parent links). Covers @if/@for/@switch/@defer and their empty/fallbacks.
    for (const key of [
      "children",
      "branches",
      "cases",
      "empty",
      "placeholder",
      "loading",
      "error",
    ]) {
      if (node[key]) walk(component, node[key]);
    }
  }
  function visit(node: ts.Node): void {
    if (tsModule.isClassDeclaration(node)) {
      const template = checker.getTemplate(node);
      if (template) walk(node, template);
    }
    tsModule.forEachChild(node, visit);
  }
  visit(entry);
  return records.map((d) => {
    const near =
      d.code === -998002 && d.file === entry.fileName
        ? hints.get(d.start)
        : undefined;
    return near
      ? { ...d, message: `${d.message.split("\n")[0]} Did you mean '${near}'?` }
      : d;
  });
}
