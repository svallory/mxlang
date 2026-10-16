/**
 * A trigger the parser read from a same-length stand-in (`&name` as `_name`,
 * `#1` as `0.`) lowers to the same tree as the form it lowers to written by
 * hand, even where Babel's checks on the stand-in's shape (`delete` of an
 * identifier, assignment to a number) would have refused it. The parser's own
 * tests pin which checks are dropped; these pin what the lowering hands on.
 */
import { describe, expect, it } from "vitest";
import memberSyntax from "../fixtures/syntax/member-fixture.ts";
import type { Dialect } from "../syntax-table.ts";
import { lowerSource, type SpannedIr } from "./index.ts";

/** A number-shaped stand-in: `#3` lowers to `self.v3`. */
const slotSyntax = {
  id: "slot",
  name: "Slot fixture",
  table: Object.freeze({
    expressionTriggers: [
      Object.freeze({
        id: "slot",
        chars: "#",
        match: "#[0-9]+",
        standIn: "number",
        node: Object.freeze({ call: "slot" }),
      }),
    ],
    attributeTriggers: [],
    lineTriggers: [],
  }),
  lowerTrigger(_id, text, _span, ctx) {
    return ctx.expression({
      type: "MemberExpression",
      object: { type: "Identifier", name: "self" },
      property: { type: "Identifier", name: `v${text.slice(1)}` },
      computed: false,
    });
  },
} satisfies Dialect;

const OFFSETS = new Set(["start", "end", "loc", "range", "extra", "span"]);

/** A node without positions or marks, so two spellings can be compared. */
const bare = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, field) =>
      OFFSETS.has(key) ? undefined : field,
    ),
  );

function lowered(source: string, dialect: Dialect) {
  const result = lowerSource(source, "/v/entity.mx", { dialect });
  expect(result.diagnostics, source).toEqual([]);
  const body = (result.ir as SpannedIr).body as unknown as {
    tag: { attrs: { kind: string; value: { code: string; node: unknown } }[] };
  }[];
  const attr = body[0]?.tag.attrs[0];
  if (attr?.kind !== "dynamic") throw new Error("no dynamic attribute");
  return { code: attr.value.code, node: bare(attr.value.node) };
}

const SAME: [string, string][] = [
  ["delete &name", "delete self.name"],
  ["delete (&name)", "delete (self.name)"],
  ["delete ((&name))", "delete ((self.name))"],
  ["typeof &name", "typeof self.name"],
  ["&name", "self.name"],
];

describe("an identifier stand-in", () => {
  it.each(SAME)("`%s` lowers as `%s`", (trigger, written) => {
    const arrow = (expr: string) => `rule check=(() => { return ${expr} })\n`;
    expect(lowered(arrow(trigger), memberSyntax)).toEqual(
      lowered(arrow(written), memberSyntax),
    );
    const value = (expr: string) => `rule check=(() => ${expr})\n`;
    expect(lowered(value(trigger), memberSyntax)).toEqual(
      lowered(value(written), memberSyntax),
    );
  });

  it("a `delete` of a member written by hand is unchanged by the trigger beside it", () => {
    const left = lowered(
      "rule check=(() => { delete self.a; return delete &b })\n",
      memberSyntax,
    );
    const right = lowered(
      "rule check=(() => { delete self.a; return delete self.b })\n",
      memberSyntax,
    );
    expect(left).toEqual(right);
  });

  it.each([
    "&a++ = 3",
    "(&a++) = 3",
    "[&a++] = y",
    "&a-- += 1",
    "(&a = 1) = 2",
  ])("`%s` is refused as its hand-written form is", (written) => {
    const messages = (source: string) =>
      lowerSource(`rule check=(() => { ${source} })\n`, "/v/entity.mx", {
        dialect: memberSyntax,
      }).diagnostics.map((d) => [d.message, d.offset]);
    const refused = messages(written);
    expect(refused).toHaveLength(1);
    // Same text with the member spelled out: the same message at the same place.
    expect(refused).toEqual(messages(written.replaceAll("&a", "_a")));
  });

  it("a real `delete x` still reports Babel's message at the same place", () => {
    const result = lowerSource(
      "rule check=(() => { let x = 1; return delete x })\n",
      "/v/entity.mx",
      { dialect: memberSyntax },
    );
    expect(result.diagnostics.map((d) => [d.message, d.offset])).toEqual([
      ["Deleting local variable in strict mode.", 38],
    ]);
  });
});

describe("a number stand-in", () => {
  const forms: [string, string][] = [
    ["#3 = 2", "self.v3 = 2"],
    ["#3 += 2", "self.v3 += 2"],
    ["#3 ||= 2", "self.v3 ||= 2"],
    ["#3 ??= 2", "self.v3 ??= 2"],
    ["#3 &&= 2", "self.v3 &&= 2"],
    ["[(#3)] = y", "[(self.v3)] = y"],
    ["#3++", "self.v3++"],
    ["--#3", "--self.v3"],
    ["(#3) = 2", "(self.v3) = 2"],
    ["[#3] = y", "[self.v3] = y"],
    ["[#3 = 1] = y", "[self.v3 = 1] = y"],
    ["[...#3] = y", "[...self.v3] = y"],
    ["({ a: #3 } = y)", "({ a: self.v3 } = y)"],
    ["for (#3 of y) {}", "for (self.v3 of y) {}"],
    ["for (#3 in y) {}", "for (self.v3 in y) {}"],
    ["delete #3", "delete self.v3"],
  ];
  it.each(forms)("`%s` lowers as `%s`", (trigger, written) => {
    const wrap = (stmt: string) => `rule check=(() => { ${stmt} })\n`;
    expect(lowered(wrap(trigger), slotSyntax)).toEqual(
      lowered(wrap(written), slotSyntax),
    );
  });

  it("an assignment to a number the user wrote still reports Babel's message", () => {
    const result = lowerSource(
      "rule check=(() => { 3 = 2 })\n",
      "/v/entity.mx",
      { dialect: slotSyntax },
    );
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "Invalid left-hand side in assignment expression.",
    ]);
  });
});
