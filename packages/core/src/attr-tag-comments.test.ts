import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { DelegatedTag, Ir, IrNode } from "./ir.ts";
import { lookup } from "./test-targets.ts";

/**
 * Marko's parser moves every comment written immediately before an `@tag`
 * into the parent's `attributeTags`. Lowering must put it back among the
 * parent's children (it is body content, not an attribute tag), in source
 * order, like any other child comment.
 */

const claimAll: HostDeclarations = {
  name: "attr-tag-comments-test",
  attrTags: 2,
  tags: {},
  isElement: () => false,
  isComponent: () => false,
  isDelegatedTag: () => true,
  resolveAttributeMethod: () => true,
};

function irOf(source: string): Ir {
  let captured: Ir | undefined;
  compileSource(source, "/tmp/attr-tag-comments.mx", claimAll, {
    targets: lookup,
    emitIr: (ir) => {
      captured = ir;
      return "";
    },
  });
  if (!captured) throw new Error("no IR captured");
  return captured;
}

function loose(source: string): DelegatedTag<unknown> {
  const node = irOf(source).body.find(
    (n: IrNode) => n.kind === "DelegatedTag" && n.tag.name === "loose",
  );
  if (node?.kind !== "DelegatedTag") throw new Error("no <loose>");
  return node.tag;
}

const shape = (children: IrNode[]) =>
  children.map((c) =>
    c.kind === "Comment"
      ? `comment:${c.value.trim()}`
      : c.kind === "Text"
        ? `text:${c.value.trim()}`
        : c.kind === "DelegatedTag"
          ? `tag:${c.tag.name}`
          : c.kind,
  );

describe("a comment beside an attribute tag", () => {
  it("before the attribute tag lowers as a child comment, not a `` attribute tag", () => {
    const tag = loose("<loose>\n  <!-- c -->\n  <@m>t</@m>\n</loose>\n");
    expect(tag.attributeTags.map((t) => t.name)).toEqual(["m"]);
    expect(tag.attributeTagTree).toHaveLength(1);
    expect(shape(tag.children)).toEqual(["comment:c"]);
  });

  it("keeps a `//` comment's html flag and span", () => {
    const src = "<loose>\n  // c\n  <@m>t</@m>\n</loose>\n";
    const tag = loose(src);
    const comment = tag.children.find((c) => c.kind === "Comment");
    expect(comment).toMatchObject({ kind: "Comment", html: false });
    if (comment?.kind !== "Comment") throw new Error("unreachable");
    expect(src.slice(comment.span?.sourceStart, comment.span?.sourceEnd)).toBe(
      "// c",
    );
  });

  it("after the attribute tag stays a child comment", () => {
    const tag = loose("<loose>\n  <@m>t</@m>\n  <!-- c -->\n</loose>\n");
    expect(tag.attributeTags.map((t) => t.name)).toEqual(["m"]);
    expect(shape(tag.children)).toEqual(["comment:c"]);
  });

  it("keeps several hoisted comments and other children in source order", () => {
    const tag = loose(
      "<loose>\n  a\n  <x/>\n  <!-- c1 -->\n  <!-- c2 -->\n  <@m>t</@m>\n  b\n  <!-- c3 -->\n  <y/>\n</loose>\n",
    );
    expect(tag.attributeTags.map((t) => t.name)).toEqual(["m"]);
    expect(shape(tag.children)).toEqual([
      "text:a",
      "tag:x",
      "comment:c1",
      "comment:c2",
      "text:b",
      "comment:c3",
      "tag:y",
    ]);
  });

  it("a comment before each of two attribute tags", () => {
    const tag = loose(
      "<loose>\n  <!-- c1 -->\n  <@m>1</@m>\n  <!-- c2 -->\n  <@n>2</@n>\n</loose>\n",
    );
    expect(tag.attributeTags.map((t) => t.name)).toEqual(["m", "n"]);
    expect(shape(tag.children)).toEqual(["comment:c1", "comment:c2"]);
  });

  it("works in concise mode", () => {
    const tag = loose("loose\n  // c\n  @m\n    t\n  x\n");
    expect(tag.attributeTags.map((t) => t.name)).toEqual(["m"]);
    expect(shape(tag.children)).toEqual(["comment:c", "tag:x"]);
  });

  it("a nested attribute tag's own hoisted comment lowers as its child", () => {
    const tag = loose(
      "<loose>\n  <@m>\n    <!-- c -->\n    <@n>t</@n>\n  </@m>\n</loose>\n",
    );
    const m = tag.attributeTags[0];
    expect(m?.attributeTags.map((t) => t.name)).toEqual(["n"]);
    expect(shape(m?.block.children ?? [])).toEqual(["comment:c"]);
  });

  it("text beside an attribute tag stays a child (regression pin)", () => {
    const tag = loose("<loose>\n  hi\n  <@m>t</@m>\n</loose>\n");
    expect(shape(tag.children)).toEqual(["text:hi"]);
  });
});
