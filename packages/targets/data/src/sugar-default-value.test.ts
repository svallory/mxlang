import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { parseData } from "./parse.ts";

/**
 * Decision 146 addendum 4 (PR 4): a sugar followed directly by `=value` or
 * `(params) { body }` sets the tag's default attribute (`value`). Mesh's
 * `boolean #isOverdue({ self }) { return self.x }` is a `boolean` tag with
 * `id="isOverdue"` and a function `value`.
 */

type Attr = { name: string; kind: string; value?: unknown };
type Node = { name?: string; attrs?: Attr[]; children?: Node[] };

function firstTag(source: string, options: Record<string, unknown> = {}) {
  const { tree, diagnostics } = parseData(source, "/d.mx", options);
  expect(diagnostics).toEqual([]);
  return (tree?.children ?? [])[0] as Node;
}

function summary(tag: Node): Record<string, string> {
  return Object.fromEntries(
    (tag.attrs ?? []).map((a) => [
      a.name,
      a.kind === "string"
        ? String(a.value)
        : String((a.value as { code?: string } | undefined)?.code ?? ""),
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
    expect(tag.attrs?.find((a) => a.name === "value")?.kind).toBe("expression");
  });

  it("as a child line", () => {
    const { tree, diagnostics } = parseData(
      "entity\n  boolean #isOverdue({ self }) { return self.x }\n  string #title\n",
      "/d.mx",
      {},
    );
    expect(diagnostics).toEqual([]);
    const entity = (tree?.children ?? [])[0] as Node;
    const [overdue, title] = entity.children ?? [];
    expect(overdue?.name).toBe("boolean");
    expect(summary(overdue as Node)).toEqual({ id: "isOverdue", value: FN });
    expect(summary(title as Node)).toEqual({ id: "title" });
  });
});

describe("each form, on the data target", () => {
  it.each([
    ["<a #x=1/>", { id: "x", value: "1" }],
    ["<a :x=input.y/>", { name: "x", value: "input.y" }],
    ["<a .c=1/>", { class: "c", value: "1" }],
    ['<a .c="s"/>', { class: "c", value: "s" }],
    ["a #x=1", { id: "x", value: "1" }],
    ["a :x=input.y", { name: "x", value: "input.y" }],
    ["a .c=1", { class: "c", value: "1" }],
    ["<a:x=1/>", { name: "x", value: "1" }],
  ])("%s", (source, expected) => {
    expect(summary(firstTag(`${source}\n`))).toEqual(expected);
  });

  it.each([
    "kind #name (p) { b }",
    "kind #name(p) { b }",
    "kind (p) { b } #name",
  ])("%s: both orders are the same tag", (source) => {
    const attrs = summary(firstTag(`${source}\n`));
    expect(attrs.id).toBe("name");
    expect(attrs.value).toMatch(/^function \(p\) \{/);
  });

  it.each([
    ["<item=a #x=b/>", 1, 11],
    ["kind=1 #x=2", 1, 10],
    ["kind (p) { b } #x(q) { c }", 1, 17],
  ])(
    "%s: a second default value is a positioned error at the second",
    (source, line, column) => {
      const { tree, diagnostics } = parseData(`${source}\n`, "/d.mx", {});
      expect(tree).toBeUndefined();
      expect(diagnostics).toMatchObject([
        {
          severity: "error",
          message: expect.stringContaining("already has a default value"),
          line,
          column,
        },
      ]);
    },
  );
});

describe("contracts see the default value", () => {
  const tags: Record<string, CustomTag> = {
    boolean: {
      attributes: { id: { type: "string" }, value: { type: "function" } },
    },
  };

  it("a function value passes `value: function`", () => {
    const { diagnostics } = parseData(
      "boolean #isOverdue({ self }) { return self.x }\n",
      "/d.mx",
      { customTags: tags },
    );
    expect(diagnostics).toEqual([]);
  });

  it("a wrong value is E1 on `value`, positioned at the sugar's value", () => {
    const { diagnostics } = parseData("boolean #isOverdue=1\n", "/d.mx", {
      customTags: tags,
    });
    expect(diagnostics).toMatchObject([
      {
        message: "`<boolean>`: attribute `value` must be function, got number",
        line: 1,
        column: 19,
      },
    ]);
  });

  it("a closed contract without `value` rejects the sugar's value at it", () => {
    const { diagnostics } = parseData("item #x=1\n", "/d.mx", {
      customTags: { item: { attributes: { id: { type: "string" } } } },
    });
    expect(diagnostics).toMatchObject([
      { message: "`<item>`: unknown attribute `value`", line: 1, column: 8 },
    ]);
  });
});
