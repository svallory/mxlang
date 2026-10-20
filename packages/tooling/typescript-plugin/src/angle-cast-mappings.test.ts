import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { codeInformation, mergeMappings } from "./language.ts";
import { createMxLanguagePlugin } from "./mx-language.ts";

describe("whole-cast diagnostic endpoints", () => {
  it("does not suppress unrelated repeated tag names without casts", () => {
    const file = fileURLToPath(
      new URL(
        "../../../core/src/fixtures/scan/template-render/page.mx",
        import.meta.url,
      ),
    );
    const source = readFileSync(file, "utf8");
    const plugin = createMxLanguagePlugin(ts);
    const virtual = plugin.createVirtualCode?.(
      file,
      "mx",
      ts.ScriptSnapshot.fromString(source),
      { getAssociatedScript: () => undefined },
    );
    expect(virtual).toBeDefined();
    expect(virtual?.mappings.length).toBeGreaterThan(0);
    expect(
      virtual?.mappings.filter(
        (mapping) => Object.keys(mapping.data).length === 0,
      ),
    ).toEqual([]);
  });
  it("does not merge a cast's endpoints into the preceding unary minus", () => {
    const minus = {
      sourceOffsets: [31],
      generatedOffsets: [546],
      lengths: [1],
      data: codeInformation,
    };
    const cast = {
      sourceOffsets: [32, 48],
      generatedOffsets: [547, 567],
      lengths: [0, 0],
      data: { verification: true },
    };
    expect(mergeMappings([minus, cast])).toEqual([minus, cast]);
    expect(minus.lengths).toEqual([1]);
  });
  it("does not copy diagnostic capabilities onto a deliberately disabled mapping", () => {
    const first = {
      sourceOffsets: [0],
      generatedOffsets: [0],
      lengths: [1],
      data: codeInformation,
    };
    const suppressed = {
      sourceOffsets: [1],
      generatedOffsets: [1],
      lengths: [1],
      data: {},
    };
    expect(mergeMappings([first, suppressed])).toEqual([first, suppressed]);
  });
});
