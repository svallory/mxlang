import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import type { DelegatedTag } from "../ir.ts";
import { type LowerSourceOptions, lowerSource, type Spanned } from "./index.ts";

/**
 * Decision 146 addendum 4 (PR 4): a sugar followed directly by `=value` or
 * `(params) { body }` sets the tag's default attribute (`value`). Mesh's
 * `boolean #isOverdue({ self }) { return self.x }` is a `boolean` tag with
 * `id="isOverdue"` and a function `value`.
 *
 * Core's `name-sugar.test.ts` already pins the sugar forms, both orders of a
 * method default, the second-default error positions and the `(at 1:5)`
 * wording; this file keeps what that one does not reach through the entry
 * point: Mesh's own destructuring spelling, the sugar-derived `name` as an
 * atom beside a default value, and the contract errors on `value`.
 */

type Attr = Spanned<DelegatedTag>["attrs"][number];

function tagsOf(source: string, options: LowerSourceOptions = {}) {
  const { ir, diagnostics } = lowerSource(source, "/d.mx", options);
  expect(diagnostics).toEqual([]);
  return (ir?.body ?? []).map((node) => {
    expect(node.kind).toBe("DelegatedTag");
    return (node as unknown as { tag: Spanned<DelegatedTag> }).tag;
  });
}

function firstTag(source: string, options: LowerSourceOptions = {}) {
  const [tag] = tagsOf(source, options);
  if (!tag) throw new Error("expected a tag");
  return tag;
}

/** Attribute name to its value: a static one's string, else the expression's code. */
function summary(tag: { attrs: Attr[] }): Record<string, string> {
  return Object.fromEntries(
    tag.attrs.map((a) => [
      a.kind === "spread" ? "..." : a.name,
      a.kind === "static"
        ? a.value
        : a.kind === "dynamic" || a.kind === "bound" || a.kind === "spread"
          ? a.value.code
          : "",
    ]),
  );
}

describe("Mesh: boolean #isOverdue({ self }) { return self.x }", () => {
  const FN = "function ({ self }) { return self.x; }";

  it.each([
    ["concise", "boolean #isOverdue({ self }) { return self.x }\n"],
    [
      "concise, space before the params",
      "boolean #isOverdue ({ self }) { return self.x }\n",
    ],
    [
      "concise, params first",
      "boolean ({ self }) { return self.x } #isOverdue\n",
    ],
    ["html", "<boolean #isOverdue({ self }) { return self.x }/>\n"],
    [
      "html, params first",
      "<boolean ({ self }) { return self.x } #isOverdue/>\n",
    ],
  ])("%s", (_name, source) => {
    const tag = firstTag(source);
    expect(tag.name).toBe("boolean");
    const attrs = summary(tag);
    expect(attrs.id).toBe("isOverdue");
    expect(attrs.value).toBe(FN);
    // A method is an expression, never a static string.
    expect(tag.attrs.find((a) => nameOf(a) === "value")?.kind).toBe("dynamic");
  });

  it("as a child line", () => {
    const entity = firstTag(
      "entity\n  boolean #isOverdue({ self }) { return self.x }\n  string #title\n",
    );
    const [overdue, title] = entity.children.map((node) => {
      expect(node.kind).toBe("DelegatedTag");
      return (node as unknown as { tag: Spanned<DelegatedTag> }).tag;
    });
    expect(overdue?.name).toBe("boolean");
    expect(summary(overdue as Spanned<DelegatedTag>)).toEqual({
      id: "isOverdue",
      value: FN,
    });
    expect(summary(title as Spanned<DelegatedTag>)).toEqual({ id: "title" });
  });
});

function nameOf(attr: Attr): string | undefined {
  return attr.kind === "spread" ? undefined : attr.name;
}

describe("the sugar-derived name stays an atom beside a default value", () => {
  it.each(["<a :x=input.y/>", "a :x=input.y", "<a:x=1/>"])("%s", (source) => {
    const name = firstTag(`${source}\n`).attrs.find(
      (a) => nameOf(a) === "name",
    );
    expect(name?.kind).toBe("static");
    if (name?.kind !== "static") return;
    expect(name.value).toBe("x");
    expect(name.atom).toMatchObject({ kind: "atom", name: "x" });
  });
});

describe("contracts see the default value", () => {
  const tags: Record<string, CustomTag> = {
    boolean: {
      attributes: { id: { type: "string" }, value: { type: "function" } },
    },
  };

  it("a function value passes `value: function`", () => {
    const { ir, diagnostics } = lowerSource(
      "boolean #isOverdue({ self }) { return self.x }\n",
      "/d.mx",
      { customTags: tags },
    );
    expect(diagnostics).toEqual([]);
    expect(ir).toBeDefined();
  });

  it("a wrong value is E1 on `value`, positioned at the sugar's value", () => {
    const { ir, diagnostics } = lowerSource("boolean #isOverdue=1\n", "/d.mx", {
      customTags: tags,
    });
    expect(ir).toBeUndefined();
    expect(diagnostics).toMatchObject([
      {
        message:
          "`<boolean>`: attribute `value` (set by `#isOverdue=…`) must be function, got number",
        line: 1,
        column: 19,
      },
    ]);
  });

  it("a closed contract without `value` rejects the sugar's value at it", () => {
    const { ir, diagnostics } = lowerSource("item #x=1\n", "/d.mx", {
      customTags: { item: { attributes: { id: { type: "string" } } } },
    });
    expect(ir).toBeUndefined();
    expect(diagnostics).toMatchObject([
      {
        message: "`<item>`: unknown attribute `value` (set by `#x=…`)",
        line: 1,
        column: 8,
      },
    ]);
  });
});
