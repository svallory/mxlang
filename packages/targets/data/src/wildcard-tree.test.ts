import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileModule, serializeDataDocument } from "./compile.ts";
import { parseData } from "./parse.ts";
import type { DataNode, DataTag } from "./tree.ts";

const tags: Record<string, CustomTag> = {
  attribute: { attributes: { type: { type: "string" } } },
  resource: {
    parents: ["#root"],
    children: {
      id: {},
      "*": [
        {
          pattern: "^(?<prefix>[a-z]+)_(?<rest>[a-z]+)$",
          contract: "attribute",
        },
        { pattern: "^[A-Z]+$", attributes: { type: { type: "string" } } },
      ],
    },
  },
  id: { parents: ["resource"] },
  attributes: {
    parents: ["#root"],
    children: { "*": { pattern: "^[a-z][a-z0-9]*$", contract: "attribute" } },
  },
  // `attribute` as a wildcard parent of itself: recursion, not a cycle.
  nested: {
    parents: ["#root", "nested"],
    children: { "*": { pattern: "^[a-z]+$", contract: "nested" } },
  },
};

function tree(source: string): DataTag[] {
  const { tree: doc, diagnostics } = parseData(source, "/w.mx", {
    customTags: tags,
    unknownTags: "reject",
  });
  expect(diagnostics).toEqual([]);
  return doc?.children.filter((n): n is DataTag => n.kind === "tag") ?? [];
}

const tagsOf = (node: DataTag): DataTag[] =>
  node.children.filter((n: DataNode): n is DataTag => n.kind === "tag");

describe("wildcard-matched tags in the data tree (decision 147)", () => {
  it("by reference: name is authored, contract is the canonical tag", () => {
    const [attributes] = tree('<attributes>\n  <title type="string"/>\n</attributes>\n');
    const [title] = tagsOf(attributes as DataTag);
    expect(title).toMatchObject({ kind: "tag", name: "title", contract: "attribute" });
    expect(title?.groups).toBeUndefined();
    // nameSpan slices the authored name.
    const src = '<attributes>\n  <title type="string"/>\n</attributes>\n';
    expect(src.slice(title?.nameSpan.sourceStart, title?.nameSpan.sourceEnd)).toBe("title");
  });

  it("carries the pattern's named groups", () => {
    const src = "<resource>\n  <foo_bar type='x'/>\n</resource>\n";
    const [resource] = tree(src);
    const [child] = tagsOf(resource as DataTag);
    expect(child).toMatchObject({
      name: "foo_bar",
      contract: "attribute",
      groups: { prefix: "foo", rest: "bar" },
    });
  });

  it("inline contract: contract equals the authored name", () => {
    const [resource] = tree("<resource>\n  <PORT type='x'/>\n</resource>\n");
    const [child] = tagsOf(resource as DataTag);
    expect(child).toMatchObject({ name: "PORT", contract: "PORT" });
    expect(child?.groups).toBeUndefined();
  });

  it("explicit children and non-wildcard tags carry no contract field", () => {
    const [resource] = tree("<resource>\n  <id/>\n</resource>\n");
    const [id] = tagsOf(resource as DataTag);
    expect(resource).not.toHaveProperty("contract");
    expect(resource).not.toHaveProperty("groups");
    expect(id).not.toHaveProperty("contract");
    expect(id).not.toHaveProperty("groups");
  });

  it("nested: a recursive wildcard marks every level", () => {
    const [nested] = tree("<nested>\n  <a>\n    <b/>\n  </a>\n</nested>\n");
    const [a] = tagsOf(nested as DataTag);
    const [b] = tagsOf(a as DataTag);
    expect(a).toMatchObject({ name: "a", contract: "nested" });
    expect(b).toMatchObject({ name: "b", contract: "nested" });
    expect(nested).not.toHaveProperty("contract");
  });

  it("serializes and compiles with the fields intact", () => {
    const src = "<resource>\n  <foo_bar type='x'/>\n</resource>\n";
    const { tree: doc } = parseData(src, "/w.mx", { customTags: tags });
    const json = JSON.parse(JSON.stringify(serializeDataDocument(doc!)));
    expect(json.children[0].children[0]).toMatchObject({
      name: "foo_bar",
      contract: "attribute",
      groups: { prefix: "foo", rest: "bar" },
    });
    const code = compileModule(src, "/w.mx", { customTags: tags }).code;
    expect(code).toContain('"contract": "attribute"');
    expect(code).toContain('"groups"');
  });
});
