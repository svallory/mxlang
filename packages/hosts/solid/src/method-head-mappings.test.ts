import { describe, expect, it } from "vitest";
import { compileSolidUnit } from "./index.ts";

const compile = (source: string) =>
  compileSolidUnit(source, { filename: "/fixtures/head.mx", customTags: {} });

describe("printed method head mappings", () => {
  it.each([
    ["a parameter type", "onClick(e: Missing) {}", "Missing"],
    ["a default parameter", 'onClick(e: number = "bad") {}', "e"],
    ["a generic constraint", "onClick<T extends Missing>(e: T) {}", "Missing"],
    ["an async head", "async onClick(e: Missing) {}", "Missing"],
    [
      "a destructured parameter with braces",
      "onClick({ value }: { value: Missing } = { value: 0 }) { bodyMissing() }",
      "Missing",
    ],
    [
      "an authored function's return type",
      "onClick=function (): Missing { return 1 }",
      "Missing",
    ],
  ])("maps %s exactly", (_name, method, token) => {
    const source = `<div>\n  <button ${method}/>\n</div>`;
    const { code, mappings } = compile(source);
    const generated = code.indexOf(token, code.indexOf("onClick="));
    const mapping = mappings.find(
      (m) =>
        m.generatedStart <= generated &&
        generated + token.length <= m.generatedEnd,
    );
    expect(mapping).toBeDefined();
    expect(
      mapping && mapping.sourceStart + generated - mapping.generatedStart,
    ).toBe(source.indexOf(token, source.indexOf("onClick")));
    expect(code.slice(mapping?.generatedStart, mapping?.generatedEnd)).toBe(
      source.slice(mapping?.sourceStart, mapping?.sourceEnd),
    );
  });

  it("maps an async generic head exactly and replaces the attribute name with function", () => {
    const source =
      "<button async onClick<T extends Missing>(e: T) { bodyMissing() }/>";
    const { code, mappings } = compile(source);
    for (const token of ["async", "Missing", "e: T"]) {
      const at = code.indexOf(token, code.indexOf("onClick="));
      const m = mappings.find(
        (item) =>
          item.generatedStart <= at && at + token.length <= item.generatedEnd,
      );
      expect(m).toBeDefined();
      expect(m && m.sourceStart + at - m.generatedStart).toBe(
        source.indexOf(token),
      );
      expect(code.slice(m?.generatedStart, m?.generatedEnd)).toBe(
        source.slice(m?.sourceStart, m?.sourceEnd),
      );
    }
    const at = code.indexOf("function ", code.indexOf("onClick="));
    expect(mappings.find((m) => m.generatedStart === at)).toEqual({
      sourceStart: 14,
      sourceEnd: 21,
      generatedStart: at,
      generatedEnd: at + "function ".length,
    });
    expect(source.slice(14, 21)).toBe("onClick");
  });

  it("does not map the inserted function keyword", () => {
    const { code, mappings } = compile(
      "<button onClick(e: Missing) { bodyMissing() }/>",
    );
    const at = code.indexOf("function (");
    expect(
      mappings.some((m) => m.generatedStart <= at && at < m.generatedEnd),
    ).toBe(false);
  });

  it("keeps head and body mapping independent for a large reformatted body", () => {
    const source = `<button onClick(e: Missing) { ${"bodyMissing();".repeat(2500)} }/>`;
    const { code, mappings } = compile(source);
    for (const token of ["Missing", "bodyMissing"]) {
      const at = code.indexOf(token);
      const m = mappings.find(
        (item) => item.generatedStart <= at && at < item.generatedEnd,
      );
      expect(m && m.sourceStart + at - m.generatedStart).toBe(
        source.indexOf(token),
      );
    }
  });
});
