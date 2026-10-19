import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

const compile = (source: string) =>
  compilePreactMx(source, "/fixtures/head.mx", { typeCheck: true });

describe("printed method head mappings", () => {
  it.each([
    ["onClick(e: Missing) {}", "Missing"],
    ['onClick(e: number = "bad") {}', "e"],
    ["onClick<T extends Missing>(e: T) {}", "Missing"],
    ["async onClick(e: Missing) {}", "Missing"],
    [
      "onClick({ value }: { value: Missing } = { value: 0 }) { bodyMissing() }",
      "Missing",
    ],
    ["onClick=function (): Missing { return 1 }", "Missing"],
  ])("maps %s exactly", (method, token) => {
    const source = `<div>\n  <button ${method}/>\n</div>`;
    const { code, mappings } = compile(source);
    const at = code.indexOf(token, code.indexOf("onClick="));
    const m = mappings.find(
      (item) =>
        item.generatedStart <= at && at + token.length <= item.generatedEnd,
    );
    expect(m).toBeDefined();
    expect(m && m.sourceStart + at - m.generatedStart).toBe(
      source.indexOf(token, source.indexOf("onClick")),
    );
    expect(code.slice(m?.generatedStart, m?.generatedEnd)).toBe(
      source.slice(m?.sourceStart, m?.sourceEnd),
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

  it("leaves inserted function unmapped", () => {
    const { code, mappings } = compile(
      "<button onClick(e: Missing) { bodyMissing() }/>",
    );
    const at = code.indexOf("function (");
    expect(
      mappings.some((m) => m.generatedStart <= at && at < m.generatedEnd),
    ).toBe(false);
  });

  it("keeps a large reformatted body's mapping independent of its head", () => {
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
