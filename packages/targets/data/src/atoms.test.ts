import { describe, expect, it } from "vitest";
import { serializeDataDocument } from "./compile.ts";
import { type ParseDataResult, parseData } from "./parse.ts";
import type { DataAttr, DataNode, DataTag } from "./tree.ts";

/**
 * Decision 156 in `parseData` (addendum 1, items 1, 2 and 10): an attribute
 * whose entire value is one atom is `DataAttr` kind `atom`, the sugar-derived
 * `name` included; an atom nested in an expression stays a `StringLiteral`
 * with `extra.mxAtom = { span }` inside `DataExpr.node`.
 */

function ok(source: string) {
  const result = parseData(source, "/t.mx");
  expect(result.diagnostics).toEqual([]);
  return result.tree as NonNullable<ParseDataResult["tree"]>;
}

function tags(nodes: readonly DataNode[]): DataTag[] {
  return nodes.flatMap((node) =>
    node.kind === "tag" ? [node, ...tags(node.children)] : [],
  );
}

function tag(source: string, name: string): DataTag {
  const found = tags(ok(source).children).find((t) => t.name === name);
  if (!found) throw new Error(`no <${name}>`);
  return found;
}

function attr(t: DataTag, name: string): DataAttr {
  const found = t.attrs.find((a) => a.kind !== "spread" && a.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

const span = (sourceStart: number, sourceEnd: number) => ({
  sourceStart,
  sourceEnd,
});

describe("a whole-value atom is DataAttr kind atom", () => {
  it("`mode=:strict`", () => {
    expect(attr(tag("<x mode=:strict/>", "x"), "mode")).toEqual({
      kind: "atom",
      name: "mode",
      value: "strict",
      nameSpan: span(3, 7),
      span: span(8, 15),
    });
  });

  it.each([
    ["<string :title/>", span(8, 14)],
    ["<string:title/>", span(7, 13)],
    ["string :title\n", span(7, 13)],
  ])("the sugar-derived name: %j", (source, atomSpan) => {
    expect(attr(tag(source, "string"), "name")).toEqual({
      kind: "atom",
      name: "name",
      value: "title",
      nameSpan: atomSpan,
      span: atomSpan,
    });
  });

  it('a string stays kind string: `name="title"`', () => {
    expect(attr(tag('<string name="title"/>', "string"), "name").kind).toBe(
      "string",
    );
  });

  it("serializes as plain data", () => {
    const result = parseData("<x mode=:strict/>", "/t.mx");
    const json = JSON.stringify(
      serializeDataDocument(result.tree as NonNullable<typeof result.tree>),
    );
    expect(json).toContain(
      '{"kind":"atom","name":"mode","value":"strict","nameSpan":{"sourceStart":3,"sourceEnd":7},"span":{"sourceStart":8,"sourceEnd":15}}',
    );
  });
});

describe("a nested atom is a StringLiteral with extra.mxAtom", () => {
  it("an atom list: `accept=[:title, :body]`", () => {
    const a = attr(tag("<policy accept=[:title, :body]/>", "policy"), "accept");
    if (a.kind !== "expression") throw new Error(a.kind);
    expect(a.value.code).toBe('["title", "body"]');
    const elements = (a.value.node as unknown as { elements: unknown[] })
      .elements;
    expect(elements).toMatchObject([
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
    const a = attr(
      tag("check that=({ self }) => self.status === :sent\n", "check"),
      "that",
    );
    if (a.kind !== "expression") throw new Error(a.kind);
    expect(a.value.code).toBe('({ self }) => self.status === "sent"');
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

  const shape = (a: DataAttr) =>
    a.kind === "expression"
      ? `${a.name}=${a.value.code}`
      : a.kind === "atom"
        ? `${a.name}=:${a.value}`
        : a.kind === "string"
          ? `${a.name}="${a.value}"`
          : a.kind === "boolean"
            ? a.name
            : "...";

  it("parses, with atoms where they were written", () => {
    const lines = tags(ok(SOURCE).children).map((t) =>
      `${t.name} ${t.attrs.map(shape).join(" ")}`.trim(),
    );
    expect(lines).toEqual([
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

  it("an atom default value then `:name` is the decision-151 error (not supported yet)", () => {
    // `belongs-to=:Customer :customer`: sugar right after a *default* value is
    // exempt from the after-value split (decision 151, ruling 2). Open for the
    // lead; see the PR 1 core report.
    const result = parseData("x\n  belongs-to=:Customer :customer\n", "/t.mx");
    expect(result.diagnostics[0]?.message).toContain(
      "right after a default value is not supported",
    );
    expect(result.diagnostics[0]).toMatchObject({ line: 2, column: 23 });
  });
});

describe("atom errors are positioned diagnostics, never a raw throw", () => {
  it.each([
    ["x y=::a\n", 1, 4, "`::a` is reserved (decision 156)"],
    ["x y=:a.b\n", 1, 4, "member access is not allowed"],
    ["<x y=f(...:a)/>", 1, 10, "spreading is not allowed"],
    ["<x y=(:a) => 1/>", 1, 6, "is an atom (decision 156): a value"],
  ] as const)("%j", (source, line, column, part) => {
    const result = parseData(source, "/t.mx");
    expect(result.tree).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain(part);
    expect(result.diagnostics[0]).toMatchObject({ line, column });
  });
});
