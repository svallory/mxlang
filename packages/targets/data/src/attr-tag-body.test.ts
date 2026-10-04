import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";
import type { DataNode, DataTag } from "./tree.ts";

/**
 * Body content written beside attribute tags: the tree carries it in
 * `children`, in source order, exactly as it does without attribute tags.
 * Marko moves a comment written right before an `@tag` into the tag's
 * `attributeTags`; the tree still reports it as a child comment.
 */

function root(source: string, options?: Parameters<typeof parseData>[2]) {
  const result = parseData(source, "/body.mx", options);
  expect(result.diagnostics).toEqual([]);
  const tag = result.tree?.children[0] as DataTag;
  expect(tag.name).toBe("loose");
  return tag;
}

const shape = (children: DataNode[]) =>
  children.map((c) =>
    c.kind === "comment"
      ? `comment:${c.value.trim()}`
      : c.kind === "text"
        ? `text:${c.value.trim()}`
        : c.kind === "tag"
          ? `tag:${c.name}`
          : c.kind,
  );

const HTML = {
  before: "<loose>\n  <!-- c -->\n  <@m>t</@m>\n</loose>\n",
  after: "<loose>\n  <@m>t</@m>\n  <!-- c -->\n</loose>\n",
  text: "<loose>\n  hi\n  <@m>t</@m>\n</loose>\n",
  both: "<loose>\n  a\n  <x/>\n  <!-- c -->\n  <@m>t</@m>\n  b\n  <y/>\n</loose>\n",
};
const CONCISE = {
  before: "loose\n  // c\n  @m\n    t\n",
  after: "loose\n  @m\n    t\n  // c\n",
  text: "loose\n  @m\n    t\n  x\n",
  both: "loose\n  a\n  // c\n  @m\n    t\n  b\n",
};

describe("body content beside attribute tags", () => {
  for (const [mode, src] of [
    ["HTML", HTML],
    ["concise", CONCISE],
  ] as const) {
    describe(mode, () => {
      it("a comment before an attribute tag is a child comment, and no `` attribute tag appears", () => {
        const tag = root(src.before);
        expect(
          tag.attrTags.map((t) => (t.kind === "attr-tag" ? t.name : t.kind)),
        ).toEqual(["m"]);
        expect(shape(tag.children)).toEqual(["comment:c"]);
        const [comment] = tag.children;
        if (comment?.kind !== "comment") throw new Error("unreachable");
        expect(
          src.before.slice(comment.span.sourceStart, comment.span.sourceEnd),
        ).toMatch(/^(<!-- c -->|\/\/ c)$/);
      });

      it("a comment after an attribute tag is a child comment", () => {
        const tag = root(src.after);
        expect(shape(tag.children)).toEqual(["comment:c"]);
      });

      it("every emitted span offset is finite", () => {
        const json = JSON.stringify(root(src.before));
        expect(json).not.toContain("null");
      });
    });
  }

  it("text beside an attribute tag stays in children (regression pin)", () => {
    expect(shape(root(HTML.text).children)).toEqual(["text:hi"]);
    expect(shape(root(CONCISE.text).children)).toEqual(["tag:x"]);
  });

  it("text, tags and a comment on both sides keep source order", () => {
    expect(shape(root(HTML.both).children)).toEqual([
      "text:a",
      "tag:x",
      "comment:c",
      "text:b",
      "tag:y",
    ]);
    expect(shape(root(CONCISE.both).children)).toEqual([
      "tag:a",
      "comment:c",
      "tag:b",
    ]);
  });

  it("structural: reject reports text and comments beside an attribute tag, at their own position", () => {
    const text = parseData(HTML.text, "/body.mx", { structural: "reject" });
    expect(text.tree).toBeUndefined();
    expect(text.diagnostics[0]).toMatchObject({ line: 2, column: 2 });
    expect(text.diagnostics[0]?.message).toContain("text");
    const comment = parseData(HTML.before, "/body.mx", {
      structural: "reject",
    });
    expect(comment.tree).toBeUndefined();
    expect(comment.diagnostics[0]).toMatchObject({ line: 2, column: 2 });
    expect(comment.diagnostics[0]?.message).toContain("comment");
  });

  it("a nested attribute tag's hoisted comment is its child", () => {
    const tag = root(
      "<loose>\n  <@m>\n    <!-- c -->\n    <@n>t</@n>\n  </@m>\n</loose>\n",
    );
    const m = tag.attrTags[0];
    if (m?.kind !== "attr-tag") throw new Error("unreachable");
    expect(
      m.attrTags.map((t) => (t.kind === "attr-tag" ? t.name : t.kind)),
    ).toEqual(["n"]);
    expect(shape(m.children)).toEqual(["comment:c"]);
  });

  it("walk order still holds: the earliest reject wins across attribute tags and children", () => {
    const reject = { structural: "reject" } as const;
    const source =
      "<loose>\n  <!-- c -->\n  <@m><if=x>a</if></@m>\n  <if=y>b</if>\n</loose>\n";
    // The hoisted comment opens first.
    expect(parseData(source, "/body.mx", reject).diagnostics[0]).toMatchObject({
      line: 2,
    });
    // Without it, the attribute tag's `<if>` opens before the child `<if>`.
    expect(
      parseData(source.replace("  <!-- c -->\n", ""), "/body.mx", reject)
        .diagnostics[0],
    ).toMatchObject({ line: 2 });
  });
});
