import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import { lowerSource } from "./index.ts";

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

describe("recursive attribute-tag contracts through lowerSource (decision 138 E4)", () => {
  it("keeps nested authored attributes, children and control flow, without applying defaults", () => {
    const valid = lowerSource(
      '<card><@group><@row n=1 values=["a"] run=(x) => x><if=enabled><item/></if><else><item/></else><for|x| of=xs><item/></for></@row></@group></card>',
      "/card.mx",
      { customTags },
    );
    expect(valid.diagnostics).toEqual([]);
    // Nested attribute tags are `attributeTags`; an attribute tag's body
    // (control flow included) is its `block.children`.
    expect(valid.ir?.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: {
        name: "card",
        attributeTags: [
          {
            name: "group",
            attributeTags: [
              {
                name: "row",
                attrs: [{ name: "n" }, { name: "values" }, { name: "run" }],
                block: { children: [{ kind: "IfChain" }, { kind: "For" }] },
              },
            ],
          },
        ],
      },
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
      const result = lowerSource(
        `<card><@group>\n  ${row}\n</@group></card>`,
        "/card.mx",
        { customTags },
      );
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        severity: "error",
        message: `\`<card>\`: \`<@group>\`: \`<@row>\`: ${message}`,
        line: 2,
      });
    },
  );
});

describe('attributeTags["*"] through lowerSource (decision 147, for attribute tags)', () => {
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
    const valid = lowerSource(
      "<resource><@on_click event='tap'/><@action-save kind='draft'/></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.ir?.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: {
        name: "resource",
        attributeTags: [
          { name: "on_click", attrs: [{ name: "event" }] },
          { name: "action-save", attrs: [{ name: "kind" }] },
        ],
      },
    });
  });

  it("an unknown attribute on a wildcard-matched name is a contract error", () => {
    const result = lowerSource(
      "<resource><@on_click nope=1/></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(
      "unknown attribute `nope`",
    );
  });

  it("an unmatched name stays unknown", () => {
    const result = lowerSource(
      "<resource><@nope/></resource>",
      "/resource.mx",
      {
        customTags: wildcardTags,
      },
    );
    expect(result.ir).toBeUndefined();
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
    const valid = lowerSource(
      "<resource><@attribute name='x'/></resource>",
      "/resource.mx",
      { customTags: namedWinsTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.ir?.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: {
        name: "resource",
        attributeTags: [{ name: "attribute", attrs: [{ name: "name" }] }],
      },
    });
  });

  it("a wildcard-matched name accepts its declared nested attribute tags", () => {
    const valid = lowerSource(
      "<resource><@action-save kind='draft'><@step/></@action-save></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(valid.diagnostics).toEqual([]);
    expect(valid.ir?.body[0]).toMatchObject({
      kind: "DelegatedTag",
      tag: {
        name: "resource",
        attributeTags: [
          {
            name: "action-save",
            attrs: [{ name: "kind" }],
            attributeTags: [{ name: "step" }],
          },
        ],
      },
    });
  });

  it("an unknown nested attribute tag under a wildcard-matched name stays unknown", () => {
    const result = lowerSource(
      "<resource><@action-save kind='draft'><@nope/></@action-save></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain(
      "unknown attribute tag `<@nope>`",
    );
  });

  it("a matched name inside `<if>` takes the wildcard entry's contract", () => {
    const valid = lowerSource(
      "<resource><if=enabled><@on_click event='tap'/></if></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(valid.diagnostics).toEqual([]);
  });

  it("one matched name inside `<for>` is a repeat", () => {
    // The loop iterates: one occurrence repeats at runtime, like core's test.
    const result = lowerSource(
      "<resource><for|i| of=[1,2]><@on_click event='tap'/></for></resource>",
      "/resource.mx",
      { customTags: wildcardTags },
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain(
      "attribute tag `<@on_click>` may not be repeated",
    );
  });
});
