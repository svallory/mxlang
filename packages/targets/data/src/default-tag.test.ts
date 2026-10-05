import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

const customTags: Record<string, CustomTag> = {
  resource: {
    attributes: { type: { type: "string" } },
  },
};

function parse(source: string, options: Record<string, unknown> = {}) {
  return parseData(source, "/d.mx", { customTags, ...options });
}

describe("the unnamed tag in a data file resolves to the built-in `object`", () => {
  it.each([
    ["<#a/>", "id"],
    ["<.a/>", "class"],
    ["#a\n", "id"],
    [".a\n", "class"],
    ["<#a.b/>", "id"],
  ])(
    "%j is a tag named `object` carrying %s as an ordinary attribute",
    (src, attr) => {
      const { tree, diagnostics } = parse(src);
      expect(diagnostics).toEqual([]);
      const tag = tree?.children[0];
      expect(tag).toMatchObject({ kind: "tag", name: "object" });
      const attrs = (tag as { attrs: Array<{ name: string }> }).attrs;
      expect(attrs.map((a) => a.name)).toContain(attr);
    },
  );

  it("passes unknownTags: reject and structural: reject with no contract", () => {
    const { tree, diagnostics } = parse('<#a/>\n<resource type="x"/>\n', {
      unknownTags: "reject",
      structural: "reject",
    });
    expect(diagnostics).toEqual([]);
    expect(tree?.children.map((n) => (n as { name: string }).name)).toEqual([
      "object",
      "resource",
    ]);
  });

  it("an authored <object/> is known too, and so is one under a contract-less parent", () => {
    const { tree, diagnostics } = parse("<resource><object/></resource>", {
      unknownTags: "reject",
    });
    expect(diagnostics).toEqual([]);
    expect(tree).toBeDefined();
  });

  it("the unknown-tag hint can name `object`", () => {
    const { diagnostics } = parse("<objec/>\n", { unknownTags: "reject" });
    expect(diagnostics[0]?.message).toContain("did you mean `<object>`?");
  });

  it("a declared `object` contract replaces the built-in", () => {
    const { diagnostics } = parse("<object bogus=1/>\n", {
      customTags: { object: { attributes: { name: { type: "string" } } } },
    });
    expect(diagnostics).not.toEqual([]);
  });

  it("a closed parent that lists neither `object` nor anything else gives the E2 error at the shorthand", () => {
    const { tree, diagnostics } = parse("<card>\n  <#a/>\n</card>", {
      customTags: { card: { children: { item: {} } } },
    });
    expect(tree).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message:
          "`<card>`: `<object>` is not allowed here; allowed children: `<item>`",
        line: 2,
        column: 2,
        offset: 9,
      },
    ]);
  });

  it("a closed parent listing `object` accepts the shorthand", () => {
    const { diagnostics } = parse("<card><#a/></card>", {
      customTags: { card: { children: { object: {} } } },
    });
    expect(diagnostics).toEqual([]);
  });

  it("the parse-only scan reports the shorthand as the resolved name, not `div`", () => {
    // An unknown parent's typo must win over a child's contract error; the
    // scan lists the shorthand as `object`, so it is never an unknown `div`.
    const { diagnostics } = parse("<card><#a/></card>", {
      customTags: { card: { children: { item: {} } } },
      unknownTags: "reject",
    });
    expect(diagnostics[0]?.message).toContain("`<object>` is not allowed here");
    expect(diagnostics[0]?.message).not.toContain("div");
  });
});

describe("a configured defaultTag (mx.data.defaultTag)", () => {
  const tags: Record<string, CustomTag> = {
    item: { attributes: { class: { type: "string" }, id: { type: "string" } } },
    strict: { attributes: { name: { type: "string" } } },
  };

  it("makes the shorthand that tag, in place of `object`", () => {
    const { tree, diagnostics } = parseData("<#a.b/>", "/d.mx", {
      customTags: tags,
      defaultTag: "item",
    });
    expect(diagnostics).toEqual([]);
    expect(tree?.children[0]).toMatchObject({ kind: "tag", name: "item" });
  });

  it("applies that tag's contract: closed attributes lacking class give E1", () => {
    const { tree, diagnostics } = parseData("<.x/>", "/d.mx", {
      customTags: tags,
      defaultTag: "strict",
    });
    expect(tree).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      line: 1,
      column: 0,
    });
    expect(diagnostics[0]?.message).toContain("`class`");
  });

  it("is known under unknownTags: reject because it is declared", () => {
    const { diagnostics } = parseData("<#a/>", "/d.mx", {
      customTags: tags,
      defaultTag: "item",
      unknownTags: "reject",
    });
    expect(diagnostics).toEqual([]);
  });

  it("the parse-only scan names the shorthand by the configured tag", () => {
    const { diagnostics } = parseData("<card><#a/></card>", "/d.mx", {
      customTags: { ...tags, card: { children: { item: {} } } },
      defaultTag: "strict",
      unknownTags: "reject",
    });
    expect(diagnostics[0]?.message).toContain("`<strict>` is not allowed here");
  });
});
