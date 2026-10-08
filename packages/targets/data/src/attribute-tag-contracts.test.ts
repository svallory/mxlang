import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

const customTags: Record<string, CustomTag> = {
  card: {
    attributeTags: {
      group: {
        children: {},
        attributeTags: {
          row: {
            repeatable: true,
            attributes: {
              n: { type: "number", required: true },
              values: { type: "array", items: "string" },
              run: { type: "function" },
              untouched: { default: "not injected" },
            },
            children: { item: { required: true, repeatable: true } },
          },
        },
      },
    },
  },
  item: { parents: ["@row"] },
};

describe("recursive attribute-tag contracts through parseData (decision 138 E4)", () => {
  it("keeps nested authored attributes, children and control flow, without applying defaults", () => {
    const valid = parseData(
      '<card><@group><@row n=1 values=["a"] run=(x) => x><if=enabled><item/></if><else><item/></else><for|x| of=xs><item/></for></@row></@group></card>',
      "/card.mx",
      { customTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.tree?.children[0]).toMatchObject({
      kind: "tag",
      name: "card",
      attrTags: [
        {
          name: "group",
          attrTags: [
            {
              name: "row",
              attrs: [{ name: "n" }, { name: "values" }, { name: "run" }],
              children: [{ kind: "if" }, { kind: "for" }],
            },
          ],
        },
      ],
    });
  });
  it.each([
    [
      '<@row n="bad"><item/></@row>',
      "attribute `n` must be number, got string",
    ],
    ["<@row n=1 bogus=2><item/></@row>", "unknown attribute `bogus`"],
    [
      "<@row n=1><bad/></@row>",
      "`<bad>` is not allowed here; allowed children: `<item>`",
    ],
    [
      "<@row n=1>hello</@row>",
      "text is not allowed here; it accepts only the child tags `<item>`",
    ],
    [
      "<@row n=1><if=enabled><item/></if></@row>",
      "missing required child `<item>`",
    ],
  ])(
    "reports one owner-chain error with no partial tree: %s",
    (row, message) => {
      const result = parseData(
        `<card><@group>\n  ${row}\n</@group></card>`,
        "/card.mx",
        { customTags },
      );
      expect(result.tree).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        severity: "error",
        message: `\`<card>\`: \`<@group>\`: \`<@row>\`: ${message}`,
        line: 2,
      });
    },
  );
});

describe("atom contracts on attribute-tag attributes through parseData (decision 156 addendum 7)", () => {
  const atomTags: Record<string, CustomTag> = {
    box: {
      declares: { kind: "node", from: "id" },
      attributeTags: {
        row: {
          repeatable: true,
          attributes: {
            mode: { type: "atom", values: ["a", "b"] },
            to: { type: "atom", ref: "node" },
          },
        },
      },
    },
  };

  it("accepts declared names and listed values", () => {
    const result = parseData("<box#k><@row mode=:a to=:k/></box>", "/a.mx", {
      customTags: atomTags,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    [
      "<box><@row mode=:zzz/></box>",
      "`<box>`: `<@row>`: attribute `mode`: `:zzz` is not one of :a, :b",
      16,
    ],
    [
      "<box><@row to=:nope/></box>",
      "`<box>`: `<@row>`: attribute `to`: `:nope` is not a declared node here (none declared)",
      14,
    ],
    [
      '<box><@row mode="a"/></box>',
      "`<box>`: `<@row>`: attribute `mode` must be atom, got string (one of :a, :b)",
      16,
    ],
  ])("reports %s at the value", (source, message, column) => {
    const result = parseData(source, "/a.mx", { customTags: atomTags });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      message,
      line: 1,
      column,
    });
  });

  it("top-level siblings share the file scope", () => {
    const tags: Record<string, CustomTag> = {
      node: { declares: { kind: "node", from: "id" } },
      link: { attributes: { to: { type: "atom", ref: "node" } } },
    };
    const result = parseData("<node#a/>\n<node#b/>\n<link to=:a/>", "/a.mx", {
      customTags: tags,
    });
    expect(result.diagnostics).toEqual([]);
  });
});

describe('attributeTags["*"] through parseData (decision 147, for attribute tags)', () => {
  const wildcardTags: Record<string, CustomTag> = {
    resource: {
      attributeTags: {
        attribute: { attributes: { name: { type: "string" } } },
        "*": [
          { pattern: "on_.*", attributes: { event: { type: "string" } } },
          {
            pattern: "action-.*",
            attributes: { kind: { type: "string", required: true } },
            attributeTags: { step: {} },
          },
        ],
      },
    },
  };

  it("a matched name takes the wildcard entry's contract", () => {
    const valid = parseData(
      "<resource><@on_click event='tap'/><@action-save kind='draft'/></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.tree?.children[0]).toMatchObject({
      kind: "tag",
      name: "resource",
      attrTags: [
        { name: "on_click", attrs: [{ name: "event" }] },
        { name: "action-save", attrs: [{ name: "kind" }] },
      ],
    });
  });

  it("an unknown attribute on a wildcard-matched name is a contract error", () => {
    const result = parseData(
      "<resource><@on_click nope=1/></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      "unknown attribute `nope`",
    );
  });

  it("an unmatched name stays unknown", () => {
    const result = parseData("<resource><@nope/></resource>", "/resource.mx", {
      customTags: wildcardTags,
    });
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain(
      "unknown attribute tag `<@nope>`",
    );
  });

  it("an explicit entry wins even when a wildcard entry would reject the attributes", () => {
    // A dedicated fixture: its wildcard alone matches `attribute` and allows
    // nothing, so `name` would fail there; the explicit entry supplies it.
    const namedWinsTags: Record<string, CustomTag> = {
      resource: {
        attributeTags: {
          attribute: { attributes: { name: { type: "string" } } },
          "*": { pattern: "attribute", attributes: {} },
        },
      },
    };
    const valid = parseData(
      "<resource><@attribute name='x'/></resource>",
      "/resource.mx",
      { customTags: namedWinsTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.tree?.children[0]).toMatchObject({
      kind: "tag",
      name: "resource",
      attrTags: [{ name: "attribute", attrs: [{ name: "name" }] }],
    });
  });

  it("a wildcard-matched name accepts its declared nested attribute tags", () => {
    const valid = parseData(
      "<resource><@action-save kind='draft'><@step/></@action-save></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.tree?.children[0]).toMatchObject({
      kind: "tag",
      name: "resource",
      attrTags: [
        {
          name: "action-save",
          attrs: [{ name: "kind" }],
          attrTags: [{ name: "step" }],
        },
      ],
    });
  });

  it("an unknown nested attribute tag under a wildcard-matched name stays unknown", () => {
    const result = parseData(
      "<resource><@action-save kind='draft'><@nope/></@action-save></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain(
      "unknown attribute tag `<@nope>`",
    );
  });

  it("a matched name inside `<if>` takes the wildcard entry's contract", () => {
    const valid = parseData(
      "<resource><if=enabled><@on_click event='tap'/></if></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(valid.diagnostics).toEqual([]);
  });

  it("one matched name inside `<for>` is a repeat", () => {
    // The loop iterates: one occurrence repeats at runtime, like core's test.
    const result = parseData(
      "<resource><for|i| of=[1,2]><@on_click event='tap'/></for></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain(
      "attribute tag `<@on_click>` may not be repeated",
    );
  });
});
