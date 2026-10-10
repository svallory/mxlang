import { describe, expect, it } from "vitest";
import type { Attr, DelegatedTag } from "../ir.ts";
import { lowerSource, type Spanned, type SpannedIr } from "./index.ts";

/**
 * Decision 156 in `lowerSource` (addendum 1, items 1, 2 and 10): an attribute
 * whose entire value is one atom is a `static` attribute carrying `atom`, the
 * sugar-derived `name` included; an atom nested in an expression stays a
 * `StringLiteral` with `extra.mxAtom = { span }` inside `Expr.node`. Core's
 * own `atoms.test.ts` pins the same lowering through `compileSource`; these
 * pin what the entry point hands a consumer (Mesh reads them from here).
 */

type Node = SpannedIr["body"][number];

function ok(source: string): SpannedIr {
  const result = lowerSource(source, "/t.mx");
  expect(result.diagnostics).toEqual([]);
  return result.ir as SpannedIr;
}

function tags(nodes: readonly Node[]): Spanned<DelegatedTag>[] {
  return nodes.flatMap((node) =>
    node.kind === "DelegatedTag" ? [node.tag, ...tags(node.tag.children)] : [],
  );
}

function tag(source: string, name: string): Spanned<DelegatedTag> {
  const found = tags(ok(source).body).find((t) => t.name === name);
  if (!found) throw new Error(`no <${name}>`);
  return found;
}

function attr(t: Spanned<DelegatedTag>, name: string): Attr {
  const found = t.attrs.find((a) => a.kind !== "spread" && a.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

/** The expression of an attribute that is not a whole-value atom. */
function exprOf(t: Spanned<DelegatedTag>, name: string) {
  const a = attr(t, name);
  if (a.kind !== "dynamic") throw new Error(a.kind);
  return a.value;
}

const span = (sourceStart: number, sourceEnd: number) => ({
  sourceStart,
  sourceEnd,
});

describe("a whole-value atom is a static attribute carrying `atom`", () => {
  it("`mode=:strict`", () => {
    expect(attr(tag("<x mode=:strict/>", "x"), "mode")).toMatchObject({
      kind: "static",
      name: "mode",
      value: "strict",
      nameSpan: span(3, 7),
      atom: { kind: "atom", name: "strict", span: span(8, 15) },
    });
  });

  it.each([
    ["<string :title/>", span(8, 14)],
    ["<string:title/>", span(7, 13)],
    ["string :title\n", span(7, 13)],
  ])("the sugar-derived name: %j", (source, atomSpan) => {
    expect(attr(tag(source, "string"), "name")).toMatchObject({
      kind: "static",
      name: "name",
      value: "title",
      nameSpan: atomSpan,
      atom: { kind: "atom", name: "title", span: atomSpan },
    });
  });

  it('a string is no atom: `name="title"`', () => {
    const a = attr(tag('<string name="title"/>', "string"), "name");
    expect(a).toMatchObject({ kind: "static", value: "title" });
    expect("atom" in a).toBe(false);
  });
});

describe("a nested atom is a StringLiteral with extra.mxAtom", () => {
  it("an atom list: `accept=[:title, :body]`", () => {
    const value = exprOf(
      tag("<policy accept=[:title, :body]/>", "policy"),
      "accept",
    );
    expect(value.code).toBe('["title", "body"]');
    expect(value.atoms).toEqual([
      { kind: "atom", name: "title", span: span(16, 22) },
      { kind: "atom", name: "body", span: span(24, 29) },
    ]);
    expect(value.node.elements).toMatchObject([
      {
        type: "StringLiteral",
        value: "title",
        extra: { mxAtom: { span: span(16, 22) } },
      },
      {
        type: "StringLiteral",
        value: "body",
        extra: { mxAtom: { span: span(24, 29) } },
      },
    ]);
  });

  it("inside a function body", () => {
    const value = exprOf(
      tag("check that=({ self }) => self.status === :sent\n", "check"),
      "that",
    );
    expect(value.code).toBe('({ self }) => self.status === "sent"');
  });
});

describe("atoms in a method-shorthand body (lead ruling 2026-10-05)", () => {
  it("convert like an arrow body's, each with its own span", () => {
    const source =
      "check that({ self }) {\n  return self.k === :a ? [:b] : :c\n}\n";
    const value = exprOf(tag(source, "check"), "that");
    expect(value.code).toBe(
      'function ({ self }) { return self.k === "a" ? ["b"] : "c"; }',
    );
    const test = value.node.body.body[0]?.argument.test.right;
    expect(test).toMatchObject({
      type: "StringLiteral",
      value: "a",
      extra: { mxAtom: { span: span(43, 45) } },
    });
    expect(source.slice(43, 45)).toBe(":a");
  });

  it("HTML mode", () => {
    const value = exprOf(
      tag("<check that(v) { return v === :a }/>", "check"),
      "that",
    );
    expect(value.code).toBe('function (v) { return v === "a"; }');
  });
});

/**
 * Mesh's syntax-v3 probe (`scratch/reports/mesh-syntax-v3-probe.md` §A): every
 * line `@mxlang/data@0.1.0-alpha.2` rejected with "Unexpected token".
 */
describe("Mesh's syntax-v3 lines", () => {
  const SOURCE = [
    'entity :Invoice table="invoices"',
    "  attributes",
    "    uuid :id primary-key",
    "    timestamp :createdAt on=:create",
    "    string :status default=:draft values=[:draft, :sent]",
    "  policy accept=[:number] auto=[:read, :destroy] types=[:read] actions=[:pay] load=[:customer] sort=[:dueOn] require=[:id]",
    "  action :pay on:load=:visible",
    "    check that=({ self }) => self.status === :sent",
    "    check that=({ self }) => self.status !== :cancelled",
    "  set",
    "    :status=:sent",
    "",
  ].join("\n");

  const shape = (a: Attr) =>
    a.kind === "dynamic"
      ? `${a.name}=${a.value.code}`
      : a.kind === "static"
        ? a.atom
          ? `${a.name}=:${a.atom.name}`
          : `${a.name}="${a.value}"`
        : a.kind === "boolean"
          ? a.name
          : "...";

  const line = (t: Spanned<DelegatedTag>) =>
    `${t.name} ${t.attrs.map(shape).join(" ")}`.trim();

  it("parses, with atoms where they were written", () => {
    expect(tags(ok(SOURCE).body).map(line)).toEqual([
      'entity name=:Invoice table="invoices"',
      "attributes",
      "uuid name=:id primary-key",
      "timestamp name=:createdAt on=:create",
      'string name=:status default=:draft values=["draft", "sent"]',
      'policy accept=["number"] auto=["read", "destroy"] types=["read"] actions=["pay"] load=["customer"] sort=["dueOn"] require=["id"]',
      "action name=:pay on:load=:visible",
      'check that=({ self }) => self.status === "sent"',
      'check that=({ self }) => self.status !== "cancelled"',
      "set",
      // Tagless `:status=:sent` under `set`: the default tag, `name` from the
      // sugar and the default value, both atoms.
      "object name=:status value=:sent",
    ]);
  });

  // Decision 146 addendum 5: a default value that is a single atom takes a
  // following ` :name` as name sugar (an atom takes no member access).
  it.each([
    [
      "x\n  belongs-to=:Customer :customer\n",
      "belongs-to value=:Customer name=:customer",
    ],
    ["x\n  has-many=:Order :orders\n", "has-many value=:Order name=:orders"],
    ["<x><has-many=:Order :orders/></x>", "has-many value=:Order name=:orders"],
    [
      "x\n  belongs-to=:Customer :customer required\n",
      "belongs-to value=:Customer name=:customer required",
    ],
  ] as const)(
    "a single-atom default value then `:name` is name sugar: %j",
    (source, expected) => {
      const found = tags(ok(source).body).find((t) => t.name !== "x");
      expect(found && line(found)).toBe(expected);
    },
  );

  it("a non-atom default value then `:name` is still the decision-151 error", () => {
    const result = lowerSource("x\n  belongs-to=a :customer\n", "/t.mx");
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]?.message).toContain(
      "right after a default value is not supported",
    );
    expect(result.diagnostics[0]).toMatchObject({ line: 2, column: 15 });
  });

  it("`:name` after a single-atom value on a non-default attribute is unchanged", () => {
    expect(lowerSource("x\n  tag y=:a :b\n", "/t.mx").diagnostics).toEqual([]);
  });
});

describe("atom errors are positioned diagnostics, never a raw throw", () => {
  it.each([
    ["x y=::a\n", 1, 4, "`::a` is reserved (decision 156)"],
    ["x y=:a.b\n", 1, 4, "member access is not allowed"],
    ["<x y=f(...:a)/>", 1, 10, "spreading is not allowed"],
    ["<x y=(:a) => 1/>", 1, 6, "is an atom (decision 156): a value"],
  ] as const)("%j", (source, line, column, part) => {
    const result = lowerSource(source, "/t.mx");
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(part);
    expect(result.diagnostics[0]).toMatchObject({ line, column });
  });
});
