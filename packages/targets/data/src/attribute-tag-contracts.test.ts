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
