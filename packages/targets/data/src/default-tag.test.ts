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

describe("a parent contract's defaultTag (the Mesh case, decision 145 PR 3)", () => {
  const mesh: Record<string, CustomTag> = {
    attributes: {
      defaultTag: "attribute",
      children: { attribute: { repeatable: true } },
    },
    attribute: {
      attributes: { id: { type: "string" }, type: { type: "string" } },
    },
  };

  it('<attributes><#title type="string"/></attributes> is <attribute id="title" type="string">', () => {
    const source = '<attributes><#title type="string"/></attributes>';
    const { tree, diagnostics } = parseData(source, "/m.mx", {
      customTags: mesh,
    });
    expect(diagnostics).toEqual([]);
    const attributes = tree?.children[0] as {
      name: string;
      children: unknown[];
    };
    expect(attributes.name).toBe("attributes");
    const attribute = attributes.children[0] as {
      name: string;
      attrs: Array<{ name: string; value?: string }>;
    };
    expect(attribute.name).toBe("attribute");
    const byName = Object.fromEntries(
      attribute.attrs.map((a) => [a.name, a.value]),
    );
    expect(byName).toEqual({ type: "string", id: "title" });
  });

  it("the parent's default beats mx.data.defaultTag; elsewhere the config answers", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      item: { attributes: { id: { type: "string" } } },
    };
    const { tree, diagnostics } = parseData(
      "<attributes><#a/></attributes>\n<#b/>",
      "/m.mx",
      { customTags: tags, defaultTag: "item" },
    );
    expect(diagnostics).toEqual([]);
    const names = (tree?.children ?? []).map(
      (n) => (n as { name: string }).name,
    );
    expect(names).toEqual(["attributes", "item"]);
    const first = tree?.children[0] as
      | { children: Array<{ name: string }> }
      | undefined;
    const inner = first?.children[0];
    expect(inner?.name).toBe("attribute");
  });

  it("a closed children that does not list the resolved name is E2, at the shorthand", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      attributes: { defaultTag: "attribute", children: { other: {} } },
    };
    const { tree, diagnostics } = parseData(
      "<attributes>\n  <#title/>\n</attributes>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(tree).toBeUndefined();
    expect(diagnostics).toMatchObject([
      {
        severity: "error",
        message:
          "`<attributes>`: `<attribute>` is not allowed here; allowed children: `<other>`",
        line: 2,
        column: 2,
      },
    ]);
  });

  it("a closed attributes without id is E1, at the shorthand", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      attribute: { attributes: { type: { type: "string" } } },
    };
    const { tree, diagnostics } = parseData(
      "<attributes>\n  <#title/>\n</attributes>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(tree).toBeUndefined();
    expect(diagnostics).toMatchObject([
      {
        severity: "error",
        message: "`<attribute>`: unknown attribute `id`",
        line: 2,
        column: 2,
      },
    ]);
  });

  it("an attribute-tag parent reads its own declaration", () => {
    const tags: Record<string, CustomTag> = {
      list: { attributeTags: { entries: { defaultTag: "entry" } } },
      entry: { attributes: { id: { type: "string" } } },
    };
    const { tree, diagnostics } = parseData(
      "<list><@entries><#a/></@entries></list>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(diagnostics).toEqual([]);
    const text = JSON.stringify(tree);
    expect(text).toContain('"name":"entry"');
  });

  it("sees through if and for between the parent and the shorthand", () => {
    const source =
      "<attributes><if=x><#a/></if><else><#b/></else><for|i| of=xs><#c/></for></attributes>";
    const { tree, diagnostics } = parseData(source, "/m.mx", {
      customTags: mesh,
    });
    expect(diagnostics).toEqual([]);
    expect(JSON.stringify(tree).match(/"name":"attribute"/g)?.length).toBe(3);
  });

  it("an invalid contract value falls through to object, with the one registration error elsewhere", () => {
    const tags: Record<string, CustomTag> = {
      attributes: { defaultTag: "nope" },
    };
    const { tree, diagnostics } = parseData(
      "<attributes><#a/></attributes>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(diagnostics).toEqual([]);
    const inner = JSON.stringify(tree);
    expect(inner).toContain('"name":"object"');
    expect(inner).not.toContain('"name":"nope"');
  });

  it("a closed children after an invalid parent defaultTag: the E2 says why (the hint)", () => {
    const tags: Record<string, CustomTag> = {
      attributes: { defaultTag: "nope", children: { attribute: {} } },
      attribute: {},
    };
    const { diagnostics } = parseData(
      "<attributes><#a/></attributes>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(diagnostics[0]?.message).toBe(
      "`<attributes>`: `<object>` is not allowed here; allowed children: `<attribute>` (the parent's `defaultTag` `nope` is invalid; see the declaration)",
    );
    // A valid-but-disallowed default carries no hint, and neither does a plain E2.
    const plain = parseData("<attributes><#a/></attributes>", "/m.mx", {
      customTags: {
        attributes: { children: { attribute: {} } },
        attribute: {},
      },
    });
    expect(plain.diagnostics[0]?.message).not.toContain("is invalid");
  });
});

// Decision 146 (PR 3): `:name` is the sugar Mesh wants. Under `<attributes>`,
// `<:title/>` is the unnamed tag, resolves through the parent's `defaultTag`
// (decision 145) and carries `name="title"`, instead of the `id` the `#title`
// shorthand sets.
describe("the Mesh case with the `:name` sugar (decision 146 PR 3)", () => {
  const mesh: Record<string, CustomTag> = {
    attributes: {
      defaultTag: "attribute",
      children: { attribute: { repeatable: true } },
    },
    attribute: {
      attributes: { name: { type: "string" }, type: { type: "string" } },
    },
  };

  it('<attributes><:title type="string"/></attributes> is <attribute name="title" type="string">', () => {
    const { tree, diagnostics } = parseData(
      '<attributes><:title type="string"/></attributes>',
      "/m.mx",
      { customTags: mesh },
    );
    expect(diagnostics).toEqual([]);
    const attributes = tree?.children[0] as {
      name: string;
      children: unknown[];
    };
    expect(attributes.name).toBe("attributes");
    const attribute = attributes.children[0] as {
      name: string;
      attrs: Array<{ name: string; value?: string }>;
    };
    expect(attribute.name).toBe("attribute");
    expect(
      Object.fromEntries(attribute.attrs.map((a) => [a.name, a.value])),
    ).toEqual({ name: "title", type: "string" });
  });

  it('the concise line `:title type="string"` is the same', () => {
    const { tree, diagnostics } = parseData(
      'attributes\n  :title type="string"\n  :year type="number"\n',
      "/m.mx",
      { customTags: mesh },
    );
    expect(diagnostics).toEqual([]);
    const attributes = tree?.children[0] as {
      children: Array<{
        name: string;
        attrs: Array<{ name: string; value?: string }>;
      }>;
    };
    expect(
      attributes.children.map((child) => [
        child.name,
        child.attrs.find((a) => a.name === "name")?.value,
      ]),
    ).toEqual([
      ["attribute", "title"],
      ["attribute", "year"],
    ]);
  });

  it("the name sugar is positioned at the token, and so is E1 on it", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      attribute: { attributes: { type: { type: "string" } } },
    };
    const { tree, diagnostics } = parseData(
      "<attributes>\n  <:title/>\n</attributes>",
      "/m.mx",
      { customTags: tags },
    );
    expect(tree).toBeUndefined();
    expect(diagnostics).toMatchObject([
      {
        severity: "error",
        message: "`<attribute>`: unknown attribute `:title` (`name`)",
        line: 2,
        column: 3,
      },
    ]);
  });

  it("a wrong type on the sugar names the token and the attribute", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      attribute: { attributes: { name: { type: "number" } } },
    };
    const { diagnostics } = parseData(
      "<attributes>\n  <attribute :title/>\n</attributes>",
      "/m.mx",
      { customTags: tags },
    );
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<attribute>`: attribute `:title` (`name`) must be number, got string",
        line: 2,
        column: 13,
      },
    ]);
  });
});
