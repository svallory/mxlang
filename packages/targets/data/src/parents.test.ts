import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

const customTags: Record<string, CustomTag> = {
  resource: { parents: ["#root"], children: { attributes: {} } },
  attributes: {
    parents: ["resource"],
    children: { attribute: { repeatable: true } },
  },
  attribute: {
    parents: ["attributes"],
    attributes: {
      value: { type: "string", required: true },
      values: { type: "array", items: "string" },
    },
  },
};

describe("allowed parents under delegate-everything declarations (decision 138 E3)", () => {
  it("validates the mash-style structure with children and attribute types", () => {
    const valid = parseData(
      '<resource><attributes><attribute="status" values=["draft", "published"]/></attributes></resource>',
      "/resource.mx",
      { customTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.tree?.children[0]).toMatchObject({
      kind: "tag",
      name: "resource",
      children: [
        {
          kind: "tag",
          name: "attributes",
          children: [{ kind: "tag", name: "attribute" }],
        },
      ],
    });
  });
  it("reports every positioned parent error with no partial tree", () => {
    const invalid = parseData(
      '<div>\n  <attribute="status"/>\n  <attribute="other"/>\n</div>',
      "/resource.mx",
      { customTags },
    );
    expect(invalid.tree).toBeUndefined();
    expect(invalid.diagnostics).toEqual([
      {
        severity: "error",
        message:
          "`<attribute>` must be inside `<attributes>`; found inside `<div>`",
        line: 2,
        column: 2,
        offset: 8,
      },
      {
        severity: "error",
        message:
          "`<attribute>` must be inside `<attributes>`; found inside `<div>`",
        line: 3,
        column: 2,
        offset: 32,
      },
    ]);
    const root = parseData('<attribute="status"/>', "/resource.mx", {
      customTags,
    });
    expect(root.tree).toBeUndefined();
    expect(root.diagnostics).toMatchObject([
      {
        message:
          "`<attribute>` must be inside `<attributes>`; found at the top level",
        line: 1,
        column: 0,
      },
    ]);
  });
  it("keeps if/for transparent without executing them", () => {
    const valid = parseData(
      '<attributes><if=enabled><attribute="a"/></if><else><for|x| of=names><attribute="b"/></for></else></attributes>',
      "/resource.mx",
      {
        customTags: {
          ...customTags,
          attributes: {
            parents: ["resource", "#root"],
            children: { attribute: { repeatable: true } },
          },
        },
      },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.tree).toBeDefined();
  });
  it("checks the converse registration contradiction with no partial tree", () => {
    const result = parseData("<other/>", "/resource.mx", {
      customTags: { p: { children: { other: {} } }, c: { parents: ["p"] } },
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        message:
          "`<c>`: parent `<p>` declares `children` without `<c>`; add `<c>` to `<p>`'s `children`, or remove `<p>` from `<c>`'s `parents`",
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
  });
  it("checks registration contradictions even when neither tag is used", () => {
    const result = parseData("<other/>", "/resource.mx", {
      customTags: { p: { children: { c: {} } }, c: { parents: ["#root"] } },
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        message:
          "`<p>`: child `<c>` declares `parents` without `<p>`; add `<p>` to `<c>`'s `parents`, or remove `<c>` from `<p>`'s `children`",
      },
    ]);
  });
});
