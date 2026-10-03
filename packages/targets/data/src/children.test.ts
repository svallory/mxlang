import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

const customTags: Record<string, CustomTag> = {
  resource: { children: { item: { required: true, repeatable: true } } },
};

describe("authored children under delegate-everything declarations (decision 138 E2)", () => {
  it("enforces a children-only contract through parseData, with no partial tree", () => {
    const valid = parseData(
      "<resource><item/><item/></resource>",
      "/resource.mx",
      { customTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.tree?.children[0]).toMatchObject({
      kind: "tag",
      name: "resource",
      children: [
        { kind: "tag", name: "item" },
        { kind: "tag", name: "item" },
      ],
    });

    const invalid = parseData(
      "<resource>\n  <bad/>\n  <other/>\n</resource>",
      "/resource.mx",
      { customTags },
    );
    expect(invalid.tree).toBeUndefined();
    expect(invalid.diagnostics).toEqual([
      {
        severity: "error",
        message:
          "`<resource>`: `<bad>` is not allowed here; allowed children: `<item>`",
        line: 2,
        column: 2,
        offset: 13,
      },
    ]);

    const missing = parseData(
      "<resource><if=enabled><item/></if></resource>",
      "/resource.mx",
      { customTags },
    );
    expect(missing.tree).toBeUndefined();
    expect(missing.diagnostics).toMatchObject([
      {
        message: "`<resource>`: missing required child `<item>`",
        line: 1,
        column: 0,
      },
    ]);
    const exhaustive = parseData(
      "<resource><if=enabled><item/></if><else><item/></else></resource>",
      "/resource.mx",
      { customTags },
    );
    expect(exhaustive.diagnostics).toEqual([]);
    expect(exhaustive.tree).toBeDefined();
  });
});
