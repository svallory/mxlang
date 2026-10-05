/**
 * `readJsxCalleeInput`, the JSX region kinds' callee reader: it hands core's
 * analyzer the module's own declarations (region bodies are not compiled), and
 * an unreadable module is advisory (`none`), never a caller error.
 */
import type { CalleeInputReader } from "@mxlang/core";
import { describe, expect, it, vi } from "vitest";
import { readJsxCalleeInput } from "./callee-reader.ts";

function request(source: string, path = "/app/Card.react.mx") {
  const analyze = vi.fn(
    (program: unknown) => ({ kind: "ok", program }) as never,
  );
  return {
    analyze,
    result: readJsxCalleeInput({
      path,
      source,
      analyze,
    } as Parameters<CalleeInputReader>[0]),
  };
}

describe("readJsxCalleeInput", () => {
  it("hands the module's declarations to the analyzer, regions uncompiled", () => {
    const { analyze, result } = request(
      `export interface Input { label: string }
export default function Card(input: Input) {
  return <p class={ on: true }>\${input.label}</p>;
}
`,
    );
    expect(analyze).toHaveBeenCalledTimes(1);
    const program = analyze.mock.calls[0]?.[0] as Array<{
      type: string;
      declaration?: { type: string; id?: { name: string } };
    }>;
    expect(program.map((node) => node.type)).toEqual([
      "ExportNamedDeclaration",
      "ExportDefaultDeclaration",
    ]);
    expect(program[0]?.declaration?.id?.name).toBe("Input");
    // The region is replaced by the `null` the reader's hook returns.
    expect(JSON.stringify(program[1])).not.toContain("JSXElement");
    expect(result).toMatchObject({ kind: "ok" });
  });

  it("reports `none` for a module that does not parse, without throwing", () => {
    const { analyze, result } = request("export interface Input {");
    expect(analyze).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "none", path: "/app/Card.react.mx" });
  });
});
