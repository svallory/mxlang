/**
 * Where a contract, warning or statement diagnostic ends (`IrDiagnostic.end`,
 * exclusive), with the same convention as `diagnostic-end.test.ts`: a
 * whole-tag error ends at the end of `<name`, an attribute's at the end of its
 * value, a text run's at the end of the text, a point error where it starts.
 * Then a contract key a module writes: the refusal ends at the end of the key.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TranslateError } from "../core.ts";
import { type CustomTag, rejectUnknownTagKeys } from "../custom-tags.ts";
import { staticKeyPathPosition } from "../scan.ts";
import { lowerSource } from "./index.ts";

const CONTRACTS = {
  card: {
    attributes: {
      title: { type: "string", required: true },
      n: { type: "number" },
    },
    children: { item: {} },
  },
  item: {},
  leaf: { children: {} },
  closed: { children: { item: {} } },
} as unknown as Record<string, CustomTag>;

/** `[code, start line, start column, [end line, end column, end offset]]`. */
function ranges(source: string) {
  return lowerSource(source, "/t.mx", {
    customTags: CONTRACTS,
  }).diagnostics.map((d) => [
    d.code,
    d.line,
    d.column,
    d.end && [d.end.line, d.end.column, d.end.offset],
  ]);
}

describe("a contract error's end", () => {
  it("a child the contract does not allow ends at the end of `<name`", () => {
    expect(ranges("<leaf>\n  <item/>\n</leaf>\n")).toEqual([
      ["MX_TAG_NOT_ALLOWED", 2, 2, [2, 7, 14]],
    ]);
  });

  it("text the contract does not allow ends at the end of the text", () => {
    expect(ranges("<closed>\n  hi there\n</closed>\n")).toEqual([
      ["MX_TEXT_NOT_ALLOWED", 2, 2, [2, 10, 19]],
    ]);
  });

  it("a missing attribute blames the whole tag: it ends at `<card`", () => {
    expect(ranges("<card>\n  <item/>\n</card>\n")).toEqual([
      ["MX_MISSING_ATTRIBUTE", 1, 0, [1, 5, 5]],
    ]);
  });

  it("an attribute error ends after the attribute's value", () => {
    expect(ranges("<card title='a' n='xy'>\n  <item/>\n</card>\n")).toEqual([
      ["MX_INVALID_ATTRIBUTE_VALUE", 1, 16, [1, 22, 22]],
    ]);
    expect(ranges("<card title='a' bogus=1/>\n")).toEqual([
      ["MX_UNKNOWN_ATTRIBUTE", 1, 16, [1, 23, 23]],
    ]);
  });
});

describe("a lowering warning's or statement error's end", () => {
  it("a duplicate attribute ends after the value of the one it blames", () => {
    expect(ranges("<x a=1 a=22/>\n")).toEqual([
      ["MX_DUPLICATE_ATTRIBUTE", 1, 3, [1, 6, 6]],
    ]);
  });

  it("a statement that does not parse is a point: it ends where it starts", () => {
    expect(ranges("import { x } from 'y'\nexport { x }\n")).toEqual([
      ["MX_INVALID_STATEMENT", 2, 9, [2, 9, 31]],
    ]);
  });
});

describe("a contract key a module writes", () => {
  it("is located from its start to the end of the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-key-end-"));
    try {
      const file = join(dir, "contracts.mjs");
      writeFileSync(file, "export default {\n  card: { bogus: 1 },\n};\n");
      expect(staticKeyPathPosition(file, ["card", "bogus"])).toEqual({
        line: 2,
        column: 10,
        end: { line: 2, column: 15 },
      });
      let error: unknown;
      try {
        rejectUnknownTagKeys("card", { bogus: 1 }, undefined, (tag, key) => {
          const at = staticKeyPathPosition(file, [tag, key]);
          return at && { ...at, file };
        });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(TranslateError);
      const refused = error as TranslateError;
      expect([refused.file, refused.line, refused.column]).toEqual([
        file,
        2,
        10,
      ]);
      expect(refused.end).toEqual({ line: 2, column: 15 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
