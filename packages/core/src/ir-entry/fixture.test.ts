import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Attr, DelegatedTag, IrNode } from "../ir.ts";
import { lowerFile, lowerSource, type Spanned } from "./index.ts";

/**
 * The Ash resource fixture (decision 131: "the mash resource example is the
 * host's first fixture"), copied from the mash plan's resource dialect
 * section. It exercises the whole attribute vocabulary: concise indentation,
 * default attributes, string attributes, bare booleans, array expressions,
 * arrow functions, and one method shorthand. It has no text, `${}`, `<if>`,
 * `<for>`, `<const>`, statements or attribute tags.
 *
 * It is a `.mx` file, which no dialect claims (decision 212), so it parses
 * with MX's default row.
 */

const fixturePath = new URL("../fixtures/ash-resource/post.mx", import.meta.url)
  .pathname;
const source = readFileSync(fixturePath, "utf8");

type Tag = Spanned<DelegatedTag>;

function slice(span: { sourceStart: number; sourceEnd: number }): string {
  return source.slice(span.sourceStart, span.sourceEnd);
}

/** Every tag in `nodes`, depth first (the fixture has no attribute tags). */
function tagsOf(nodes: readonly Spanned<IrNode>[]): Tag[] {
  const out: Tag[] = [];
  for (const node of nodes) {
    if (node.kind === "DelegatedTag") {
      const tag = node.tag;
      out.push(tag);
      out.push(...tagsOf(tag.children));
    }
  }
  return out;
}

function attrsOf(tag: Tag): Spanned<Attr>[] {
  return tag.attrs;
}

describe("the Ash resource fixture", () => {
  const result = lowerSource(source, fixturePath);

  it("lowers with no diagnostics", () => {
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toBeDefined();
  });

  it("lowers to the 31-tag tree (measured in the design note's P3)", () => {
    const ir = result.ir;
    if (!ir) throw new Error("expected an IR");
    // No module-level statements of any kind.
    expect(ir.imports).toEqual([]);
    expect(ir.hoisted).toEqual([]);
    expect(ir.inputInterface).toBeNull();
    expect(ir.body).toHaveLength(1);
    const tags = tagsOf(ir.body);
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
    const ir = result.ir;
    if (!ir) throw new Error("expected an IR");
    for (const tag of tagsOf(ir.body)) {
      expect(slice(tag.nameSpan)).toBe(tag.name);
      // Concise mode: the whole-tag span starts at the tag's own name and
      // includes its indented body.
      expect(slice(tag.span).startsWith(tag.name)).toBe(true);
    }
    // The root tag's span covers the whole file, final newline excluded —
    // a tag's span is the tag, and the line terminator after it is not part
    // of it (the concise-mode trim, round 2 finding 6).
    const root = ir.body[0];
    if (root?.kind !== "DelegatedTag") throw new Error("expected root tag");
    expect(slice(root.tag.span)).toBe(source.replace(/\r?\n$/, ""));
  });

  it("every attribute's spans slice the authored source", () => {
    const ir = result.ir;
    if (!ir) throw new Error("expected an IR");
    for (const tag of tagsOf(ir.body)) {
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
        if (attr.kind === "static") {
          if (!attr.valueSpan) throw new Error("expected a value span");
          expect(slice(attr.valueSpan)).toBe(`"${attr.value}"`);
        } else if (attr.kind === "dynamic") {
          expect(slice(attr.value.span)).toContain("");
        }
      }
    }
  });

  it("expression spans slice the authored text; `code` is the printed form", () => {
    const ir = result.ir;
    if (!ir) throw new Error("expected an IR");
    const tags = tagsOf(ir.body);
    const change = tags.find((tag) => tag.name === "change");
    if (!change) throw new Error("expected a change tag");
    const changeValue = change.attrs[0];
    if (changeValue?.kind !== "dynamic") {
      throw new Error("expected dynamic attr");
    }
    expect(slice(changeValue.value.span)).toBe(
      "({ post, actor }) => { post.authorId = actor.id }",
    );

    // The method shorthand: authored as `value({ post }) { ... }`, printed
    // as a function expression (measured in the note's §2.1).
    const value = tags.find((tag) => tag.name === "value");
    if (!value) throw new Error("expected a value tag");
    const method = value.attrs[0];
    if (method?.kind !== "dynamic") throw new Error("expected dynamic");
    expect(method.name).toBe("value");
    expect(method.value.code).toContain("function ({ post })");
    expect(slice(method.value.span).startsWith("({ post }) {")).toBe(true);

    // The array attributes keep their authored text too.
    const defaults = tags.find((tag) => tag.name === "defaults");
    const defaultsValue = defaults?.attrs[0];
    if (defaultsValue?.kind !== "dynamic") {
      throw new Error("expected dynamic attr");
    }
    expect(defaultsValue.value.shape).toBe("array");
    expect(slice(defaultsValue.value.span)).toBe('["read", "destroy"]');
  });

  it("the fixture's attribute vocabulary lands in the expected kinds", () => {
    const ir = result.ir;
    if (!ir) throw new Error("expected an IR");
    const tags = tagsOf(ir.body);
    const attribute = tags.find((tag) => tag.name === "attribute");
    expect(attribute?.attrs.map((attr) => attr.kind)).toEqual([
      "static",
      "static",
      "boolean",
      "boolean",
    ]);
    const stateAttr = tags.filter((tag) => tag.name === "attribute")[2];
    expect(stateAttr?.attrs.map((attr) => attr.kind)).toEqual([
      "static",
      "static",
      "dynamic",
      "static",
    ]);
  });

  it("lowerFile lowers the same file from disk", () => {
    const fromDisk = lowerFile(fixturePath);
    expect(fromDisk.diagnostics).toEqual([]);
    expect(fromDisk.ir).toEqual(result.ir);
  });
});
