import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseData, parseDataFile } from "./parse.ts";
import type { DataAttr, DataAttrTagNode, DataNode, DataTag } from "./tree.ts";

/**
 * The Ash resource fixture (decision 131: "the mash resource example is the
 * host's first fixture"), copied from the mash plan's resource dialect
 * section. It exercises the whole attribute vocabulary: concise indentation,
 * default attributes, string attributes, bare booleans, array expressions,
 * arrow functions, and one method shorthand. It has no text, `${}`, `<if>`,
 * `<for>`, `<const>`, statements or attribute tags.
 */

const fixturePath = new URL("../fixtures/ash-resource/post.mx", import.meta.url)
  .pathname;
const source = readFileSync(fixturePath, "utf8");

function slice(span: { sourceStart: number; sourceEnd: number }): string {
  return source.slice(span.sourceStart, span.sourceEnd);
}

function tagsOf(
  nodes: (DataNode | DataAttrTagNode)[],
): Extract<DataNode, { kind: "tag" }>[] {
  const out: Extract<DataNode, { kind: "tag" }>[] = [];
  for (const node of nodes) {
    if (node.kind === "tag") {
      out.push(node);
      out.push(...tagsOf(node.children));
      out.push(...tagsOf(node.attrTags));
    }
  }
  return out;
}

function attrsOf(tag: DataTag): DataAttr[] {
  return tag.attrs;
}

describe("the Ash resource fixture", () => {
  const result = parseData(source, fixturePath);

  it("builds with no diagnostics", () => {
    expect(result.diagnostics).toEqual([]);
    expect(result.tree).toBeDefined();
  });

  it("builds the 31-tag tree (measured in the design note's P3)", () => {
    const tree = result.tree;
    if (!tree) throw new Error("expected a tree");
    expect(tree.statements).toEqual([]);
    expect(tree.children).toHaveLength(1);
    const tags = tagsOf(tree.children);
    expect(tags).toHaveLength(31);
    expect(tags.map((tag) => tag.name)).toEqual([
      "resource",
      "attributes",
      "uuid-primary-key",
      "attribute",
      "attribute",
      "attribute",
      "timestamps",
      "relationships",
      "belongs-to",
      "has-many",
      "actions",
      "defaults",
      "create",
      "change",
      "update",
      "change",
      "validate",
      "read",
      "filter",
      "sort",
      "policies",
      "policy",
      "authorize-if",
      "authorize-if",
      "policy",
      "authorize-if",
      "calculations",
      "calculate",
      "value",
      "aggregates",
      "count",
    ]);
  });

  it("every tag's nameSpan and span slice the authored source", () => {
    const tree = result.tree;
    if (!tree) throw new Error("expected a tree");
    for (const tag of tagsOf(tree.children)) {
      expect(slice(tag.nameSpan)).toBe(tag.name);
      // Concise mode: the whole-tag span starts at the tag's own name and
      // includes its indented body.
      expect(slice(tag.span).startsWith(tag.name)).toBe(true);
    }
    // The root tag's span covers the whole file, final newline included.
    const root = tree.children[0];
    if (root?.kind !== "tag") throw new Error("expected root tag");
    expect(slice(root.span)).toBe(source);
  });

  it("every attribute's spans slice the authored source", () => {
    const tree = result.tree;
    if (!tree) throw new Error("expected a tree");
    for (const tag of tagsOf(tree.children)) {
      for (const attr of attrsOf(tag)) {
        if (attr.kind === "spread") continue;
        // A default attribute has a zero-width name span at the `=`. A
        // shorthand `#id`/`.cls` has none at all; this fixture writes none.
        const nameSpan = attr.nameSpan;
        if (!nameSpan) throw new Error(`\`${attr.name}\` carries no name span`);
        if (attr.name === "value") {
          expect(nameSpan.sourceStart).toBe(nameSpan.sourceEnd);
        } else {
          expect(slice(nameSpan)).toBe(attr.name);
        }
        if (attr.kind === "string") {
          expect(slice(attr.valueSpan)).toBe(`"${attr.value}"`);
        } else if (attr.kind === "expression") {
          expect(slice(attr.value.span)).toContain("");
        }
      }
    }
  });

  it("expression spans slice the authored text; `code` is the printed form", () => {
    const tree = result.tree;
    if (!tree) throw new Error("expected a tree");
    const tags = tagsOf(tree.children);
    const change = tags.find((tag) => tag.name === "change");
    if (!change) throw new Error("expected a change tag");
    const changeValue = change.attrs[0];
    if (changeValue?.kind !== "expression") {
      throw new Error("expected expression attr");
    }
    expect(slice(changeValue.value.span)).toBe(
      "({ post, actor }) => { post.authorId = actor.id }",
    );

    // The method shorthand: authored as `value({ post }) { ... }`, printed
    // as a function expression (measured in the note's §2.1).
    const value = tags.find((tag) => tag.name === "value");
    if (!value) throw new Error("expected a value tag");
    const method = value.attrs[0];
    if (method?.kind !== "expression") throw new Error("expected expression");
    expect(method.name).toBe("value");
    expect(method.value.code).toContain("function ({ post })");
    expect(slice(method.value.span).startsWith("({ post }) {")).toBe(true);

    // The array attributes keep their authored text too.
    const defaults = tags.find((tag) => tag.name === "defaults");
    const defaultsValue = defaults?.attrs[0];
    if (defaultsValue?.kind !== "expression") {
      throw new Error("expected expression attr");
    }
    expect(defaultsValue.value.shape).toBe("array");
    expect(slice(defaultsValue.value.span)).toBe('["read", "destroy"]');
  });

  it("the fixture's attribute vocabulary lands in the expected kinds", () => {
    const tree = result.tree;
    if (!tree) throw new Error("expected a tree");
    const tags = tagsOf(tree.children);
    const attribute = tags.find((tag) => tag.name === "attribute");
    expect(attribute?.attrs.map((attr) => attr.kind)).toEqual([
      "string",
      "string",
      "boolean",
      "boolean",
    ]);
    const stateAttr = tags.filter((tag) => tag.name === "attribute")[2];
    expect(stateAttr?.attrs.map((attr) => attr.kind)).toEqual([
      "string",
      "string",
      "expression",
      "string",
    ]);
  });

  it("parseDataFile parses the same file from disk", () => {
    const fromDisk = parseDataFile(fixturePath);
    expect(fromDisk.diagnostics).toEqual([]);
    expect(fromDisk.tree).toEqual(result.tree);
  });
});
