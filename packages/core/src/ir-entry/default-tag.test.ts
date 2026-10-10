import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import type { DelegatedTag } from "../ir.ts";
import { type LowerSourceOptions, lowerSource, type Spanned } from "./index.ts";

/**
 * The default tag as `lowerSource` sees it (decision 145): the built-in
 * `object`, the `defaultTag` option, and a parent contract's `defaultTag`.
 * Core's own `default-tag*.test.ts` and `contract-default-tag.test.ts` pin the
 * resolver and the ladder against test policies; these pin that the entry
 * point's declarations (`object` always known, no contract of its own) wire
 * the ladder up and report its errors. Nothing there lowers a source through
 * the entry point, so no case below is a duplicate of one there.
 */

const customTags: Record<string, CustomTag> = {
  resource: {
    attributes: { type: { type: "string" } },
  },
};

function parse(source: string, options: LowerSourceOptions = {}) {
  return lowerSource(source, "/d.mx", { customTags, ...options });
}

type Tag = Spanned<DelegatedTag>;

function tagOf(node: { kind: string } | undefined): Tag {
  expect(node?.kind).toBe("DelegatedTag");
  return (node as unknown as { tag: Tag }).tag;
}

/** A tag's attributes by name: a static value, else an expression's source. */
function attrValues(tag: Tag): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of tag.attrs) {
    if (attr.kind === "static") out[attr.name] = attr.value;
    else if ("value" in attr && typeof attr.value === "object") {
      if ("name" in attr) out[attr.name] = attr.value.code;
    }
  }
  return out;
}

/**
 * The name of every `DelegatedTag` under `nodes`, in document order, through
 * children, control flow and attribute tags (their `attributeTagTree`, not the
 * flat `attributeTags` list that repeats it).
 */
function tagNames(nodes: readonly unknown[]): string[] {
  const names: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.kind === "DelegatedTag") {
      names.push((node.tag as { name: string }).name);
    }
    for (const key of [
      "tag",
      "block",
      "children",
      "branches",
      "nodes",
      "attributeTagTree",
    ]) {
      walk(node[key]);
    }
  };
  walk(nodes);
  return names;
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
      const { ir, diagnostics } = parse(src);
      expect(diagnostics).toEqual([]);
      const tag = tagOf(ir?.body[0]);
      expect(tag.name).toBe("object");
      expect(tag.attrs.map((a) => ("name" in a ? a.name : null))).toContain(
        attr,
      );
    },
  );

  it("passes unknownTags: reject and structural: reject with no contract", () => {
    const { ir, diagnostics } = parse('<#a/>\n<resource type="x"/>\n', {
      unknownTags: "reject",
      structural: "reject",
    });
    expect(diagnostics).toEqual([]);
    expect(ir?.body.map((n) => tagOf(n).name)).toEqual(["object", "resource"]);
  });

  it("an authored <object/> is known too, and so is one under a contract-less parent", () => {
    const { ir, diagnostics } = parse("<resource><object/></resource>", {
      unknownTags: "reject",
    });
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
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
    const { ir, diagnostics } = parse("<card>\n  <#a/>\n</card>", {
      customTags: { card: { children: { item: {} } } },
    });
    expect(ir).toBeUndefined();
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
    const { ir, diagnostics } = lowerSource("<#a.b/>", "/d.mx", {
      customTags: tags,
      defaultTag: "item",
    });
    expect(diagnostics).toEqual([]);
    expect(tagOf(ir?.body[0]).name).toBe("item");
  });

  it("applies that tag's contract: closed attributes lacking class give E1", () => {
    const { ir, diagnostics } = lowerSource("<.x/>", "/d.mx", {
      customTags: tags,
      defaultTag: "strict",
    });
    expect(ir).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      line: 1,
      column: 0,
    });
    expect(diagnostics[0]?.message).toContain("`class`");
  });

  it("is known under unknownTags: reject because it is declared", () => {
    const { diagnostics } = lowerSource("<#a/>", "/d.mx", {
      customTags: tags,
      defaultTag: "item",
      unknownTags: "reject",
    });
    expect(diagnostics).toEqual([]);
  });

  it("the parse-only scan names the shorthand by the configured tag", () => {
    const { diagnostics } = lowerSource("<card><#a/></card>", "/d.mx", {
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
    const { ir, diagnostics } = lowerSource(source, "/m.mx", {
      customTags: mesh,
    });
    expect(diagnostics).toEqual([]);
    const attributes = tagOf(ir?.body[0]);
    expect(attributes.name).toBe("attributes");
    const attribute = tagOf(attributes.children[0]);
    expect(attribute.name).toBe("attribute");
    expect(attrValues(attribute)).toEqual({ type: "string", id: "title" });
  });

  it("the parent's default beats mx.data.defaultTag; elsewhere the config answers", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      item: { attributes: { id: { type: "string" } } },
    };
    const { ir, diagnostics } = lowerSource(
      "<attributes><#a/></attributes>\n<#b/>",
      "/m.mx",
      { customTags: tags, defaultTag: "item" },
    );
    expect(diagnostics).toEqual([]);
    expect(ir?.body.map((n) => tagOf(n).name)).toEqual(["attributes", "item"]);
    const first = tagOf(ir?.body[0]);
    expect(tagOf(first.children[0]).name).toBe("attribute");
  });

  it("a closed children that does not list the resolved name is E2, at the shorthand", () => {
    const tags: Record<string, CustomTag> = {
      ...mesh,
      attributes: { defaultTag: "attribute", children: { other: {} } },
    };
    const { ir, diagnostics } = lowerSource(
      "<attributes>\n  <#title/>\n</attributes>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(ir).toBeUndefined();
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
    const { ir, diagnostics } = lowerSource(
      "<attributes>\n  <#title/>\n</attributes>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(ir).toBeUndefined();
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
    const { ir, diagnostics } = lowerSource(
      "<list><@entries><#a/></@entries></list>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(diagnostics).toEqual([]);
    const entries = tagOf(ir?.body[0]).attributeTags[0];
    expect(entries?.name).toBe("entries");
    expect(tagOf(entries?.block.children[0]).name).toBe("entry");
  });

  it("sees through if and for between the parent and the shorthand", () => {
    const source =
      "<attributes><if=x><#a/></if><else><#b/></else><for|i| of=xs><#c/></for></attributes>";
    const { ir, diagnostics } = lowerSource(source, "/m.mx", {
      customTags: mesh,
    });
    expect(diagnostics).toEqual([]);
    expect(tagNames(ir?.body ?? [])).toEqual([
      "attributes",
      "attribute",
      "attribute",
      "attribute",
    ]);
  });

  it("an invalid contract value falls through to object, with the one registration error elsewhere", () => {
    const tags: Record<string, CustomTag> = {
      attributes: { defaultTag: "nope" },
    };
    const { ir, diagnostics } = lowerSource(
      "<attributes><#a/></attributes>",
      "/m.mx",
      {
        customTags: tags,
      },
    );
    expect(diagnostics).toEqual([]);
    expect(tagNames(ir?.body ?? [])).toEqual(["attributes", "object"]);
  });

  it("a closed children after an invalid parent defaultTag: the E2 says why (the hint)", () => {
    const tags: Record<string, CustomTag> = {
      attributes: { defaultTag: "nope", children: { attribute: {} } },
      attribute: {},
    };
    const { diagnostics } = lowerSource(
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
    const plain = lowerSource("<attributes><#a/></attributes>", "/m.mx", {
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
    const { ir, diagnostics } = lowerSource(
      '<attributes><:title type="string"/></attributes>',
      "/m.mx",
      { customTags: mesh },
    );
    expect(diagnostics).toEqual([]);
    const attributes = tagOf(ir?.body[0]);
    expect(attributes.name).toBe("attributes");
    const attribute = tagOf(attributes.children[0]);
    expect(attribute.name).toBe("attribute");
    expect(attrValues(attribute)).toEqual({ name: "title", type: "string" });
  });

  it('the concise line `:title type="string"` is the same', () => {
    const { ir, diagnostics } = lowerSource(
      'attributes\n  :title type="string"\n  :year type="number"\n',
      "/m.mx",
      { customTags: mesh },
    );
    expect(diagnostics).toEqual([]);
    const attributes = tagOf(ir?.body[0]);
    expect(
      attributes.children.map((child) => {
        const tag = tagOf(child);
        return [tag.name, attrValues(tag).name];
      }),
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
    const { ir, diagnostics } = lowerSource(
      "<attributes>\n  <:title/>\n</attributes>",
      "/m.mx",
      { customTags: tags },
    );
    expect(ir).toBeUndefined();
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
    const { diagnostics } = lowerSource(
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

// Round 3 (review A): a data vocabulary may name a tag after a statement
// (`class`); the entry point's tag rules make it an ordinary tag, so the sugar
// applies.
describe("name sugar on a data tag named like a statement", () => {
  const classAttrs = (source: string) => {
    const { ir, diagnostics } = lowerSource(source, "/c.mx", {});
    expect(diagnostics).toEqual([]);
    const find = (nodes: readonly { kind: string }[]): Tag | undefined => {
      for (const node of nodes) {
        if (node.kind !== "DelegatedTag") continue;
        const tag = tagOf(node);
        if (tag.name === "class") return tag;
        const hit = find(tag.children);
        if (hit) return hit;
      }
      return undefined;
    };
    return find(ir?.body ?? [])?.attrs.map((a) => [
      "name" in a ? a.name : null,
      a.kind === "static" ? a.value : undefined,
    ]);
  };

  it.each([
    ["<class :User/>\n"],
    ["<root><class :User/></root>\n"],
    ["root\n  class :User\n"],
  ])("%j gives name=User", (source) => {
    expect(classAttrs(source)).toEqual([["name", "User"]]);
  });
});
