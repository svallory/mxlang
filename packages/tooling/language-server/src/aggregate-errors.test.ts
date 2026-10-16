import { describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

const POLICY = { target: "html" } as const;

/** Every diagnostic as `[code, startLine, startChar, endLine, endChar]`. */
function shapes(source: string, unexpected: unknown[] = []) {
  const diagnostics = diagnoseDocument(
    source,
    "/app/page.mx",
    POLICY,
    (error) => unexpected.push(error),
  );
  return diagnostics.map((d) => [
    d.code,
    d.range.start.line,
    d.range.start.character,
    d.range.end.line,
    d.range.end.character,
  ]);
}

describe("a file with several parse errors (a CompileErrors aggregate)", () => {
  it("publishes one positioned diagnostic per error", () => {
    const unexpected: unknown[] = [];
    expect(shapes("<div x=(1+)/>\n<span x=(2+)/>\n", unexpected)).toEqual([
      ["MX_PARSE_EXPRESSION", 0, 10, 0, 11],
      ["MX_PARSE_EXPRESSION", 1, 11, 1, 12],
    ]);
    expect(unexpected).toEqual([]);
  });

  it("publishes both errors of an unclosed for, the cause before its cascade", () => {
    const unexpected: unknown[] = [];
    expect(shapes("<for of=[1]|x|>\n</for>", unexpected)).toEqual([
      ["MX_PARSE_EXPRESSION", 0, 13, 0, 15],
      ["MX_PARSE_MISSING_END_TAG", 0, 0, 1, 6],
    ]);
    expect(unexpected).toEqual([]);
  });

  it("keeps the single-error case as it was", () => {
    expect(shapes("<div x=(1+)/>\n")).toEqual([
      ["MX_PARSE_EXPRESSION", 0, 10, 0, 11],
    ]);
  });
});
