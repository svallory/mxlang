import { describe, expect, it } from "vitest";
import type { DelegatedTag } from "../ir.ts";
import {
  type LowerSourceOptions,
  lowerSource,
  type Spanned,
  type SpannedIr,
} from "./index.ts";

/**
 * Body content written beside attribute tags: `lowerSource` carries it in the
 * tag's `children`, in source order, exactly as it does without attribute
 * tags. Marko moves a comment written right before an `@tag` into the tag's
 * `attributeTags`; the IR still reports it as a child `Comment`. Core's own
 * `attr-tag-comments.test.ts` pins the lowering through `compileSource`; the
 * cases here are the ones that add what the entry point returns (spans on the
 * comments, `structural: "reject"`, the walk order of its rejects).
 */

type Node = SpannedIr["body"][number];

function root(source: string, options?: LowerSourceOptions) {
  const result = lowerSource(source, "/body.mx", options);
  expect(result.diagnostics).toEqual([]);
  const node = result.ir?.body[0];
  if (node?.kind !== "DelegatedTag") throw new Error("no tag");
  expect(node.tag.name).toBe("loose");
  return node.tag as Spanned<DelegatedTag>;
}

const shape = (children: readonly Node[]) =>
  children.map((c) =>
    c.kind === "Comment"
      ? `comment:${c.value.trim()}`
      : c.kind === "Text"
        ? `text:${c.value.trim()}`
        : c.kind === "DelegatedTag"
          ? `tag:${c.tag.name}`
          : c.kind,
  );

/** Every `sourceStart`/`sourceEnd` under `value`, Babel nodes aside. */
function spanOffsets(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, child]) =>
    key === "node" || key === "paramNodes"
      ? []
      : key === "sourceStart" || key === "sourceEnd"
        ? [child]
        : spanOffsets(child, seen),
  );
}

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
        expect(tag.attributeTags.map((t) => t.name)).toEqual(["m"]);
        expect(shape(tag.children)).toEqual(["comment:c"]);
        const [comment] = tag.children;
        if (comment?.kind !== "Comment") throw new Error("unreachable");
        expect(
          src.before.slice(comment.span.sourceStart, comment.span.sourceEnd),
        ).toMatch(/^(<!-- c -->|\/\/ c)$/);
      });

      it("a comment after an attribute tag is a child comment", () => {
        const tag = root(src.after);
        expect(shape(tag.children)).toEqual(["comment:c"]);
      });

      it("every emitted span offset is finite", () => {
        const offsets = spanOffsets(root(src.before));
        expect(offsets.length).toBeGreaterThan(0);
        expect(offsets.every((offset) => Number.isFinite(offset))).toBe(true);
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

  it("structural: reject reports text beside an attribute tag; a comment stays a child comment (decision 131 addendum 5)", () => {
    const text = lowerSource(HTML.text, "/body.mx", { structural: "reject" });
    expect(text.ir).toBeUndefined();
    expect(text.diagnostics[0]).toMatchObject({ line: 2, column: 2 });
    expect(text.diagnostics[0]?.message).toContain("text");
    const comment = lowerSource(
      "<loose>\n  <!-- c -->\n  <@m><x/></@m>\n</loose>\n",
      "/body.mx",
      { structural: "reject" },
    );
    expect(comment.ir).toBeDefined();
    expect(comment.diagnostics).toEqual([]);
    expect(
      shape(
        root("<loose>\n  <!-- c -->\n  <@m><x/></@m>\n</loose>\n", {
          structural: "reject",
        }).children,
      ),
    ).toEqual(["comment:c"]);
  });

  it("walk order still holds: the earliest reject wins across attribute tags and children; comments are skipped", () => {
    const reject = { structural: "reject" } as const;
    const source =
      "<loose>\n  <!-- c -->\n  <@m><if=x>a</if></@m>\n  <if=y>b</if>\n</loose>\n";
    // The comment is not a reject, so the attribute tag's `<if>` at line 3 wins.
    expect(
      lowerSource(source, "/body.mx", reject).diagnostics[0],
    ).toMatchObject({
      line: 3,
    });
    // Without the comment, the same `<if>` still opens first.
    expect(
      lowerSource(source.replace("  <!-- c -->\n", ""), "/body.mx", reject)
        .diagnostics[0],
    ).toMatchObject({ line: 2 });
  });

  describe("after an attribute-tag `<if>` chain", () => {
    const chain = "<if=x><@m>M</@m></if>";

    it("keeps a comment before the next attribute tag, with its span", () => {
      const source = `<loose>${chain}<!-- c --><@n>N</@n></loose>\n`;
      const tag = root(source);
      expect(tag.attributeTagTree.map((n) => n.kind)).toEqual([
        "AttributeTagIf",
        "AttributeTag",
      ]);
      expect(shape(tag.children)).toEqual(["comment:c"]);
      const [comment] = tag.children;
      if (comment?.kind !== "Comment") throw new Error("unreachable");
      expect(
        source.slice(comment.span.sourceStart, comment.span.sourceEnd),
      ).toBe("<!-- c -->");
    });
  });
});
