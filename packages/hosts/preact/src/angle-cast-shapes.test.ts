// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template fixtures

import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

function outcome(source: string, typeCheck: boolean) {
  try {
    const result = compilePreactMx(source, "/fixtures/angle-shapes.mx", {
      typeCheck,
    });
    return { accepted: true, code: result.code };
  } catch (error) {
    const failure = error as { message: string; line: number; column: number };
    return {
      accepted: false,
      message: failure.message,
      line: failure.line,
      column: failure.column,
    };
  }
}

describe("shape checks through angle and authored as wrappers", () => {
  it("adds repeated range mappings only for projected angles", () => {
    for (const [from, step, projected] of [
      ["input.num", "2", false],
      ["(<number>input.num)", "(<number>input.num)", true],
    ] as const) {
      const source = `export interface Input {num: number}\n<for|i| from=${from} to=10 step=${step}>\n\${i}</for>`;
      const compiled = compilePreactMx(source, "/fixtures/range-mappings.mx", {
        typeCheck: true,
      });
      const at = source.indexOf("input.num");
      expect(
        compiled.mappings?.some((m) => m.sourceStart <= at && m.sourceEnd > at),
      ).toBe(projected);
    }
  });
  it.each([
    '<p style=(<any>{ color: "red" })/>',
    '<p style=({ color: "red" } as any)/>',
    '<for|k| in=input.o by=(<any>"id")>${k}</for>',
    "<p x:y=(<any>(() => 1))/>",
    '<p title=(<any>"red")/>',
    '<for|item| of=input.items by=(<any>"id")>${item}</for>',
    "<const/F=(<any>(() => null))/><F/>",
  ])("agrees at runtime and in typeCheck: %s", (source) => {
    const runtime = outcome(source, false);
    const checked = outcome(source, true);
    expect(checked.accepted).toBe(runtime.accepted);
    if (!runtime.accepted) expect(checked).toEqual(runtime);
    else if (source.includes("title=")) {
      expect(runtime.code).toContain('title="red"');
      expect(checked.code).toContain('"red" as any');
    } else if (source.includes("of=input.items")) {
      expect(runtime.code).toContain("item.id");
      expect(checked.code).toContain('(void (("id" as any)), item.id)');
      expect(checked.code).not.toContain('item[("id" as any)]');
    }
  });
});
