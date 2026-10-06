import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

// Three independent errors: a scriptlet, an `<if>` without a condition, CDATA.
const SOURCE = [
  "<object>ok</object>",
  "$ const a = 1",
  "<if></if>",
  "<![CDATA[raw]]>",
  "",
].join("\n");

describe("parseData consumes core's error list (decision 162)", () => {
  it("reports each of three independent errors once, in position order", () => {
    const { tree, diagnostics } = parseData(SOURCE, "/data/page.mx");
    expect(tree).toBeUndefined();
    expect(diagnostics.map((d) => d.line)).toEqual([2, 3, 4]);
    expect(diagnostics.every((d) => d.severity === "error")).toBe(true);
    expect(diagnostics[0]?.message).toContain("scriptlets");
    expect(diagnostics[1]?.message).toContain("without a condition");
    expect(diagnostics[2]?.message).toContain("CDATA");
  });

  it("does not duplicate them beside the unknown-tag scan", () => {
    const { diagnostics } = parseData(
      `${SOURCE}<mystery/>\n`,
      "/data/page.mx",
      { unknownTags: "reject" },
    );
    const keys = diagnostics.map((d) => `${d.line}:${d.column}:${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(diagnostics.map((d) => d.line)).toEqual([2, 3, 4, 5]);
  });
});
