import { describe, expect, it } from "vitest";
import type { Expr } from "./ir.ts";
import { type GeneratedMapping, mappedExpr } from "./mapping.ts";

function rewritten(before: string, code: string): Expr {
  return {
    code,
    unrewrittenCode: before,
    shape: "other",
    node: null,
    span: { sourceStart: 100, sourceEnd: 100 + before.length },
  } as Expr;
}

const terms = (count: number, read: string) =>
  Array.from({ length: count }, (_, k) => `${read}.a${k}`).join(" + ");

/** The source offset the mappings give to the first `needle` in `code`. */
function sourceOffsetOf(
  { code, mappings }: { code: string; mappings: GeneratedMapping[] },
  needle: string,
): number | undefined {
  const at = code.indexOf(needle);
  const hit = mappings.find(
    (m) =>
      m.generatedStart <= at &&
      at + needle.length <= m.generatedEnd &&
      m.generatedEnd - m.generatedStart === m.sourceEnd - m.sourceStart,
  );
  return hit ? hit.sourceStart + (at - hit.generatedStart) : undefined;
}

describe("rewritten-read mappings", () => {
  it("keeps exact columns for a normal rewritten expression", () => {
    const result = mappedExpr(
      rewritten("i + row.name + z", "i() + row().name + z"),
    );
    expect(sourceOffsetOf(result, ".name + z")).toBe(100 + "i + row".length);
    expect(sourceOffsetOf(result, "z")).toBe(100 + "i + row.name + ".length);
  });

  it("maps a large rewritten expression fast, degrading past the cap", () => {
    const before = terms(5000, "row");
    const after = terms(5000, "row()");
    const started = performance.now();
    const { mappings } = mappedExpr(rewritten(before, after));
    expect(performance.now() - started).toBeLessThan(500);
    expect(mappings.length).toBeGreaterThan(0);
    // The unchanged tail after the last rewrite is still exact.
    const last = mappings[mappings.length - 1];
    expect(last?.generatedEnd).toBe(after.length);
    expect(last?.sourceEnd).toBe(100 + before.length);
  });

  it("stays exact below the cap on a mid-size expression", () => {
    const before = terms(100, "row");
    const after = terms(100, "row()");
    const result = mappedExpr(rewritten(before, after));
    expect(sourceOffsetOf(result, ".a77")).toBe(100 + before.indexOf(".a77"));
  });
});
