import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { lowerSource } from "./index.ts";

const customTags: Record<string, CustomTag> = {
  resource: { children: { item: { required: true, repeatable: true } } },
};

describe("authored children under delegate-everything declarations (decision 138 E2)", () => {
  it("enforces a children-only contract through lowerSource, with no partial IR", () => {
    const valid = lowerSource(
      "<resource><item/><item/></resource>",
      "/resource.mx",
      { customTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.ir?.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: {
        name: "resource",
        children: [
          { kind: "DelegatedTag", tag: { name: "item" } },
          { kind: "DelegatedTag", tag: { name: "item" } },
        ],
      },
    });

    const invalid = lowerSource(
      "<resource>\n  <bad/>\n  <other/>\n</resource>",
      "/resource.mx",
      { customTags },
    );
    expect(invalid.ir).toBeUndefined();
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

    const missing = lowerSource(
      "<resource><if=enabled><item/></if></resource>",
      "/resource.mx",
      { customTags },
    );
    expect(missing.ir).toBeUndefined();
    expect(missing.diagnostics).toMatchObject([
      {
        message: "`<resource>`: missing required child `<item>`",
        line: 1,
        column: 0,
      },
    ]);
    const exhaustive = lowerSource(
      "<resource><if=enabled><item/></if><else><item/></else></resource>",
      "/resource.mx",
      { customTags },
    );
    expect(exhaustive.diagnostics).toEqual([]);
    expect(exhaustive.ir).toBeDefined();
  });
});
