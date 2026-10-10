import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import type { DelegatedTag, IrNode } from "../ir.ts";
import { builtinTagNames } from "./declarations.ts";
import { lowerSource, type Spanned } from "./index.ts";

type Tag = Spanned<DelegatedTag>;

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

/** The tags among `nodes`, each as the `DelegatedTag` it carries. */
const tagsIn = (nodes: readonly Spanned<IrNode>[]): Tag[] =>
  nodes.flatMap((node) => (node.kind === "DelegatedTag" ? [node.tag] : []));

function tree(source: string): Tag[] {
  const { ir, diagnostics } = lowerSource(source, "/w.mx", {
    customTags: tags,
    unknownTags: "reject",
  });
  expect(diagnostics).toEqual([]);
  return tagsIn(ir?.body ?? []);
}

/**
 * The IR keeps the wildcard match the data tree used to project into
 * `name`/`contract`/`groups`, with the two names the other way round: the
 * data tree's `name` was the authored spelling and `contract` the canonical
 * tag; the IR's `tag.name` is the canonical contract name and `tag.alias`
 * (present only on a claimed child) holds the authored spelling and the
 * pattern's named groups.
 */
describe("wildcard-matched tags in the IR (decision 147)", () => {
  it("by reference: name is the canonical tag, alias.authored the authored one", () => {
    const src = '<attributes>\n  <title type="string"/>\n</attributes>\n';
    const [attributes] = tree(src);
    const [title] = tagsIn(attributes?.children ?? []);
    expect(title).toMatchObject({
      name: "attribute",
      alias: { authored: "title", groups: {} },
    });
    // nameSpan slices the authored name, and so does the alias's span.
    expect(
      src.slice(title?.nameSpan.sourceStart, title?.nameSpan.sourceEnd),
    ).toBe("title");
    expect(
      src.slice(title?.alias?.span?.sourceStart, title?.alias?.span?.sourceEnd),
    ).toBe("title");
  });

  it("carries the pattern's named groups", () => {
    const src = "<resource>\n  <foo_bar type='x'/>\n</resource>\n";
    const [resource] = tree(src);
    const [child] = tagsIn(resource?.children ?? []);
    expect(child).toMatchObject({
      name: "attribute",
      alias: { authored: "foo_bar", groups: { prefix: "foo", rest: "bar" } },
    });
  });

  it("inline contract: the canonical name equals the authored name", () => {
    const [resource] = tree("<resource>\n  <PORT type='x'/>\n</resource>\n");
    const [child] = tagsIn(resource?.children ?? []);
    expect(child).toMatchObject({ name: "PORT", alias: { authored: "PORT" } });
    expect(child?.alias?.groups).toEqual({});
  });

  it("explicit children and non-wildcard tags carry no alias", () => {
    const [resource] = tree("<resource>\n  <id/>\n</resource>\n");
    const [id] = tagsIn(resource?.children ?? []);
    expect(resource).not.toHaveProperty("alias");
    expect(id).toMatchObject({ name: "id" });
    expect(id).not.toHaveProperty("alias");
  });

  it("nested: a recursive wildcard marks every level", () => {
    const [nested] = tree("<nested>\n  <a>\n    <b/>\n  </a>\n</nested>\n");
    const [a] = tagsIn(nested?.children ?? []);
    const [b] = tagsIn(a?.children ?? []);
    expect(a).toMatchObject({ name: "nested", alias: { authored: "a" } });
    expect(b).toMatchObject({ name: "nested", alias: { authored: "b" } });
    expect(nested).not.toHaveProperty("alias");
  });
});

/**
 * One meaning of "built-in" (decision 147 addendum 2, decision 148): the
 * names the entry point's declarations list in `builtinTags` (`object`) are
 * built-ins for a `children["*"]` wildcard exactly as they are for the
 * `defaultTag` check.
 */
describe("builtinTags and the wildcard", () => {
  const holders: Record<string, CustomTag> = {
    entry: { attributes: { value: { type: "string" } } },
    holder: {
      parents: ["#root"],
      children: { "*": [{ contract: "entry" }] },
    },
  };

  const messages = (source: string) =>
    lowerSource(source, "/u.mx", { customTags: holders }).diagnostics.map(
      (d) => d.message,
    );

  it("the entry point declares `object` as a built-in", () => {
    expect(builtinTagNames()).toEqual(["object"]);
  });

  it("a catch-all `*` parent does not claim `<object>`, with the message every built-in gets", () => {
    const object = messages("<holder>\n  <object value='a'/>\n</holder>\n");
    const other = messages("<holder>\n  <let value='a'/>\n</holder>\n");
    expect(object).toHaveLength(1);
    expect(object[0]).toContain("`<object>` is a built-in tag");
    expect(other[0]).toContain("`<let>` is a built-in tag");
  });

  it("an ordinary name is still claimed by the catch-all", () => {
    expect(messages("<holder>\n  <thing value='a'/>\n</holder>\n")).toEqual([]);
  });
});
