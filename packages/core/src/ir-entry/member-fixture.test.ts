/**
 * The `&` member shapes through `lowerSource` with the member fixture dialect
 * (`../fixtures/syntax/member-fixture.ts`) loaded two ways: a dialect package naming it in `mx.dialect.module`, and
 * the `dialect` option. Then the cases that must not be members, and the
 * `member:Member` contract slot's acceptance matrix; a member is a node type the
 * fixture dialect registers, and core has no member vocabulary. Core's `triggers.test.ts`
 * pins the same module through `compileSource`; these pin what the entry
 * point hands a consumer, since its options (`unknownTags`, `customTags`,
 * `dialect`) change the path.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import atomSyntax, { ATOM_VALUE } from "../fixtures/syntax/atom-fixture.ts";
import { MEMBER } from "../fixtures/syntax/member-fixture.ts";
import type { Attr, DelegatedTag } from "../ir.ts";
import type { Dialect } from "../syntax-table.ts";
import {
  type LowerSourceOptions,
  lowerSource,
  type Spanned,
  type SpannedIr,
} from "./index.ts";
import { dialectPackage } from "./test-dialect-package.ts";

const MODULE = join(
  import.meta.dirname,
  "../fixtures/syntax/member-fixture.ts",
);

/** Loaded the way a dialect package's module loads (Node's strip-only `require`). */
const memberSyntax = (
  createRequire(import.meta.url)(MODULE) as { default: Dialect }
).default;

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-member-")));
  dialectPackage(dir, MODULE, { id: "member", name: "Fixture" });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The two ways a consumer loads the module. */
const LOADERS: [string, () => [string, LowerSourceOptions]][] = [
  ["a dialect package", () => [join(dir, "entity.member.mx"), {}]],
  ["the `dialect` option", () => ["/v/entity.mx", { dialect: memberSyntax }]],
];

type SpannedTag = Spanned<DelegatedTag>;

function ir(
  source: string,
  file: string,
  options: LowerSourceOptions,
): SpannedIr {
  const result = lowerSource(source, file, options);
  expect(result.diagnostics).toEqual([]);
  return result.ir as SpannedIr;
}

/** The tags among `nodes` (top level, or a tag's `children`). */
function tags(nodes: readonly { kind: string }[]): SpannedTag[] {
  return nodes.flatMap((node) =>
    node.kind === "DelegatedTag"
      ? [(node as unknown as { tag: SpannedTag }).tag]
      : [],
  );
}

function attrNamed(tag: SpannedTag, name: string): Attr {
  const found = tag.attrs.find(
    (attr) => attr.kind !== "spread" && attr.name === name,
  );
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

/** The expression of an attribute that must be dynamic. */
function exprOf(tag: SpannedTag, name: string) {
  const attr = attrNamed(tag, name);
  if (attr.kind !== "dynamic") throw new Error(attr.kind);
  return attr.value;
}

describe.each(LOADERS)("the five member cases, via %s", (_, load) => {
  it("`() => &status === done`: a `Member` node whose forward is `self.status`, the rest unchanged", () => {
    const [file, options] = load();
    const source = "rule check=(() => &status === done)\n";
    const [rule] = tags(ir(source, file, options).body);
    const check = exprOf(rule as SpannedTag, "check");
    // `code` is spliced; the span still slices the authored text.
    expect(check.code).toBe("() => self.status === done");
    expect(source.slice(12, 34)).toBe("() => &status === done");
    expect(check.span).toEqual({ sourceStart: 12, sourceEnd: 34 });
    expect(check.node).toMatchObject({
      type: "ArrowFunctionExpression",
      body: {
        type: "BinaryExpression",
        left: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "self" },
          property: { type: "Identifier", name: "status" },
        },
        right: { type: "Identifier", name: "done" },
      },
    });
    // The member is listed by node; its forward is the very object `node`
    // holds, and nothing is marked on it.
    const forward = (check.node as any).body.left;
    expect(check.nodes).toHaveLength(1);
    expect(check.nodes?.[0]).toMatchObject({
      type: "member:Member",
      span: { sourceStart: 18, sourceEnd: 25 },
      node: { type: "member:Member", name: "status" },
    });
    expect(check.nodes?.[0]?.forward).toBe(forward);
    expect(forward.extra).toBeUndefined();
  });

  it("`load=[&customer, &other]`: an array of members, each a node beside its forward", () => {
    const [file, options] = load();
    const [rule] = tags(
      ir("rule load=[&customer, &other]\n", file, options).body,
    );
    const value = exprOf(rule as SpannedTag, "load");
    expect(value.shape).toBe("array");
    expect(value.node).toMatchObject({
      type: "ArrayExpression",
      elements: [
        {
          type: "MemberExpression",
          property: { name: "customer" },
        },
        {
          type: "MemberExpression",
          property: { name: "other" },
        },
      ],
    });
    expect(value.nodes?.map((n) => [n.type, n.span])).toEqual([
      ["member:Member", { sourceStart: 11, sourceEnd: 20 }],
      ["member:Member", { sourceStart: 22, sourceEnd: 28 }],
    ]);
    const [first, second] = (value.node as any).elements;
    expect(value.nodes?.map((n) => n.forward)).toEqual([first, second]);
  });

  it("`sort asc &dueOn`: the static member variant, never the expression form", () => {
    const [file, options] = load();
    const [sort] = tags(ir("sort asc &dueOn\n", file, options).body);
    expect((sort as SpannedTag).attrs).toMatchObject([
      {
        kind: "boolean",
        name: "asc",
        nameSpan: { sourceStart: 5, sourceEnd: 8 },
      },
      {
        // A whole-value member is a `static` attribute whose `node` is the
        // dialect's `member:Member`; core adds no member field.
        kind: "static",
        name: "member",
        value: "dueOn",
        node: {
          type: "member:Member",
          name: "dueOn",
          span: { sourceStart: 9, sourceEnd: 15 },
        },
        span: { sourceStart: 9, sourceEnd: 15 },
      },
    ]);
    expect((sort as SpannedTag).attrs[1]).not.toHaveProperty("member");
  });

  it("`&title`: a `member` child with a static `name`", () => {
    const [file, options] = load();
    const [entity] = tags(ir("entity\n  &title\n", file, options).body);
    const [member] = tags((entity as SpannedTag).children);
    expect(member?.name).toBe("member");
    expect(member?.attrs).toMatchObject([
      {
        kind: "static",
        name: "name",
        value: "title",
        nameSpan: { sourceStart: 9, sourceEnd: 15 },
        valueSpan: { sourceStart: 10, sourceEnd: 15 },
      },
    ]);
  });

  it("`&title`: the child carries `trigger` (id, span, text); an authored `<member>` has none", () => {
    const [file, options] = load();
    const source = 'entity\n  &title\n  <member name="x"/>\n';
    const [entity] = tags(ir(source, file, options).body);
    const [line, authored] = tags((entity as SpannedTag).children);
    expect(line?.trigger).toEqual({
      id: "member",
      span: { sourceStart: 9, sourceEnd: 15 },
      text: "&title",
    });
    expect(source.slice(9, 15)).toBe("&title");
    expect(authored?.name).toBe("member");
    expect(authored && "trigger" in authored).toBe(false);
  });

  it("`&amount=expr`: `trigger.text` is the trigger alone, not its `=value`", () => {
    const [file, options] = load();
    const source = "set\n  &amount=qty\n";
    const [set] = tags(ir(source, file, options).body);
    const [amount] = tags((set as SpannedTag).children);
    expect(amount?.trigger).toMatchObject({ id: "member", text: "&amount" });
  });

  it("`&amount=qty * price` under a concise block: a dynamic `value`, the member inside it a node", () => {
    const [file, options] = load();
    const source = "set\n  &title\n  &amount=qty * &price\n";
    const [set] = tags(ir(source, file, options).body);
    const members = tags((set as SpannedTag).children);
    expect(members.map((member) => member.name)).toEqual(["member", "member"]);
    const amount = members[1] as SpannedTag;
    expect(attrNamed(amount, "name")).toMatchObject({ value: "amount" });
    const value = attrNamed(amount, "value");
    if (value.kind !== "dynamic") throw new Error(value.kind);
    expect(value.nameSpan).toEqual({ sourceStart: 22, sourceEnd: 22 });
    expect(value.value.code).toBe("qty * self.price");
    expect(value.value.node).toMatchObject({
      type: "BinaryExpression",
      left: { type: "Identifier", name: "qty" },
      right: { type: "MemberExpression" },
    });
    expect(value.value.nodes).toMatchObject([
      { type: "member:Member", node: { name: "price" } },
    ]);
  });
});

describe("what is not a member", () => {
  const parse = (source: string) =>
    lowerSource(source, "/v/entity.mx", { dialect: memberSyntax });

  it.each([
    ["`&&`", "rule x=(a && b)\n", "LogicalExpression"],
    ["`a &b`", "rule x=(a &b)\n", "BinaryExpression"],
    ["`&=`", "rule x=(a &= b)\n", "AssignmentExpression"],
  ])("%s is the operator", (_, source, type) => {
    const result = parse(source);
    expect(result.diagnostics).toEqual([]);
    const [rule] = tags(result.ir?.body ?? []);
    const x = attrNamed(rule as SpannedTag, "x");
    expect(x.kind === "dynamic" && x.value.node?.type).toBe(type);
    expect(JSON.stringify(x)).not.toContain("mxMember");
  });

  it("`&x` in a string, an expression comment and a line comment stays text", () => {
    const result = parse('// &a\nrule x="&b" y=(c /* &d */)\n');
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result.ir)).not.toContain("mxMember");
    const [rule] = tags(result.ir?.body ?? []);
    expect(attrNamed(rule as SpannedTag, "x")).toMatchObject({
      kind: "static",
      value: "&b",
    });
  });

  it.each([
    ["`{ &a }`", "rule v=({ &a })\n", 10],
    ["`{ &a: 1 }`", "rule v=({ &a: 1 })\n", 10],
    ["`{ &a() {} }`", "rule v=({ &a() {} })\n", 10],
  ])("%s: a member is no property name", (_, source, column) => {
    const result = parse(source);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        message:
          "`&a` is not a whole operand here: the `member` trigger lowers to an expression; write it where a value stands",
        line: 1,
        column,
      }),
    ]);
  });

  it("`{ [&a]: 1 }` and `{ k: &a }` are operands", () => {
    const result = parse("rule v=({ [&a]: 1, k: &b })\n");
    expect(result.diagnostics).toEqual([]);
    const [rule] = tags(result.ir?.body ?? []);
    expect(exprOf(rule as SpannedTag, "v").code).toBe(
      "{ [self.a]: 1, k: self.b }",
    );
  });

  it.each([
    ["x m(&a) {}\n", 4],
    ["x m(&a = 1) {}\n", 4],
    ["x m({ a: &a }) {}\n", 9],
    ["x m([&a]) {}\n", 5],
    ["x m(...&a) {}\n", 7],
  ])("%j: a member in a method's parameters is refused", (source, column) => {
    const result = parse(source);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        message:
          "`&a` (the `member` trigger) cannot be declared: it lowers to an expression, and a parameter or declaration needs a plain name",
        line: 1,
        column,
      }),
    ]);
  });

  it("`x m(p = &a) {}`: a member as a parameter's default is an operand", () => {
    const result = parse("x m(p = &a) {}\n");
    expect(result.diagnostics).toEqual([]);
    const [x] = tags(result.ir?.body ?? []);
    expect(exprOf(x as SpannedTag, "m").code).toBe("function (p = self.a) {}");
  });

  it("`(&a) => 1` is refused: a member cannot be declared", () => {
    const result = parse("rule x=((&a) => 1)\n");
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        message:
          "`&a` (the `member` trigger) cannot be declared: it lowers to an expression, and a parameter or declaration needs a plain name",
        line: 1,
        column: 9,
      }),
    ]);
  });

  it.each([
    ["set\n  &a=1\n", 9],
    ["set\n  &a = 1\n", 11],
  ])("%j: `&a = 1` spacing gives the same child", (source, valueStart) => {
    const result = parse(source);
    expect(result.diagnostics).toEqual([]);
    const [set] = tags(result.ir?.body ?? []);
    const [member] = tags((set as SpannedTag).children);
    expect(attrNamed(member as SpannedTag, "name")).toMatchObject({
      value: "a",
    });
    expect(attrNamed(member as SpannedTag, "value")).toMatchObject({
      kind: "dynamic",
      value: {
        code: "1",
        span: { sourceStart: valueStart, sourceEnd: valueStart + 1 },
      },
    });
  });

  it.each(["sort asc &a=1\n", "sort asc &a(x) { return 1 }\n"])(
    "%j: after a kind a member takes no value",
    (source) => {
      const result = parse(source);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          message: "`&a` is a member reference and takes no value",
          line: 1,
          column: 9,
        }),
      ]);
    },
  );
});

describe("a `member:Member` contract slot", () => {
  const contract = (
    type: "member:Member" | "member:Atom" | "expression",
  ): CustomTag => ({
    attributes: { slot: { type } },
  });
  const run = (
    type: "member:Member" | "member:Atom" | "expression",
    value: string,
  ) =>
    lowerSource(`sort ${value}\n`, "/v/entity.mx", {
      dialect: {
        ...memberSyntax,
        // The atom fixture's whole-value row and node type, under this
        // dialect's id, so `slot=~due-on` is a whole-value atom.
        table: {
          ...memberSyntax.table,
          valueTriggers: [
            { ...ATOM_VALUE, node: { type: "Atom", dialect: "member" } },
          ],
        },
        nodeTypes: { ...memberSyntax.nodeTypes, ...atomSyntax.nodeTypes },
        // The member lands in the declared slot.
        lowerTrigger: (_id, text, span, ctx) =>
          ctx.attribute("slot", {
            type: "member:Member",
            name: text.slice(1),
            span,
          }),
      },
      customTags: { sort: contract(type) },
    }).diagnostics.map((diagnostic) => diagnostic.message);

  it("`member:Member` accepts a member", () => {
    expect(run("member:Member", "&dueOn")).toEqual([]);
  });

  it("`member:Member` passes an expression with no knowable type, as any node-type slot does", () => {
    expect(run("member:Member", "slot=(a.b)")).toEqual([]);
  });

  it("`expression` accepts a member", () => {
    expect(run("expression", "&dueOn")).toEqual([]);
  });

  it("a node type refuses a member", () => {
    expect(run("member:Atom", "&dueOn")).toEqual([
      expect.stringContaining(
        "attribute `slot` must be member:Atom, got member:Member",
      ),
    ]);
  });

  it.each([
    ["member:Atom", "slot=~due-on"],
    ["string", 'slot="dueOn"'],
    ["boolean", "slot"],
  ])("`member:Member` refuses %s", (got, value) => {
    expect(run("member:Member", value)).toEqual([
      expect.stringContaining(
        `attribute \`slot\` must be member:Member, got ${got}`,
      ),
    ]);
  });
});

describe("the unknown-tag scan takes the module too (PR 450's parseMxDocument)", () => {
  it("after a lowering error, the scan still finds an unknown tag beside members", () => {
    // The scan runs only when lowering fails (`asc=1` against a boolean).
    const result = lowerSource("sort &a asc=1\nfoo\n", "/v/entity.mx", {
      dialect: memberSyntax,
      unknownTags: "reject",
      customTags: {
        sort: {
          attributes: {
            asc: { type: "boolean" },
            member: { type: "member:Member" },
          },
        },
      },
    });
    const messages = result.diagnostics.map((d) => d.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("attribute `asc` must be boolean");
    expect(messages[1]).toContain("`<foo>`");
  });
});

describe("one member per slot, and the member type's refusals", () => {
  const parse = (source: string, options: LowerSourceOptions = {}) =>
    lowerSource(source, "/v/entity.mx", { dialect: memberSyntax, ...options });
  const codeOf = (source: string, pick: (tag: SpannedTag) => unknown) => {
    const result = parse(source);
    expect(result.diagnostics).toEqual([]);
    return pick(tags(result.ir?.body ?? [])[0] as SpannedTag);
  };

  it.each([
    [
      "a computed method body",
      "total() { return &qty * &price }\n",
      "function () { return self.qty * self.price; }",
    ],
    [
      "nested arrays in a method",
      "rule total() { return [[&a], &b] }\n",
      "function () { return [[self.a], self.b]; }",
    ],
  ])("M1: %s lowers every member", (_, source, code) => {
    expect(
      codeOf(source, (tag) => {
        const attr = tag.attrs[0];
        return attr?.kind === "dynamic" && attr.value.code;
      }),
    ).toBe(code);
  });

  it("M1: tag arguments lower their members", () => {
    expect(
      codeOf("x(&a, [&b])\n", (tag) => tag.args.map((arg) => arg.code)),
    ).toEqual(["self.a", "[self.b]"]);
  });

  it("M4: an `&` line beside an unrelated expression error reports only that error", () => {
    const result = parse("set\n  &title\n  rule x=(a b)\n", {
      unknownTags: "reject",
      customTags: {
        set: {},
        member: { attributes: { name: { type: "string" } } },
        rule: { attributes: { x: { type: "expression" } } },
      },
    });
    const messages = result.diagnostics.map((d) => d.message);
    expect(messages).toHaveLength(1);
    expect(messages.join("\n")).not.toContain("is not a known tag");
  });

  // `member:Atom` is a node type the dialect registers (the atom fixture's
  // `Atom`, under this dialect's id), so the slot is a node-type slot.
  const withAtoms: Dialect = {
    ...memberSyntax,
    nodeTypes: { ...memberSyntax.nodeTypes, ...atomSyntax.nodeTypes },
  };
  const slot = (type: "member:Member" | "member:Atom", source: string) =>
    parse(source, {
      dialect: withAtoms,
      customTags: { sort: { attributes: { load: { type } } } },
    }).diagnostics.map((d) => d.message);

  it("M5: a `member:Member` slot accepts a dynamic value that is one member", () => {
    expect(slot("member:Member", "sort load=&visible\n")).toEqual([]);
  });

  it("M5: a `member:Member` slot refuses a string, as any node-type slot does", () => {
    expect(slot("member:Member", 'sort load="visible"\n')).toEqual([
      expect.stringContaining(
        "attribute `load` must be member:Member, got string",
      ),
    ]);
  });

  it("M5: a node-type slot refuses the dynamic form too", () => {
    expect(slot("member:Atom", "sort load=&visible\n")).toEqual([
      expect.stringContaining(
        "attribute `load` must be member:Atom, got member:Member",
      ),
    ]);
  });

  it.each([
    ["member:Member", "sort load=(&visible as any)\n"],
    ["member:Member", "sort load=(&visible!)\n"],
    ["member:Member", "sort load=((&visible as any) satisfies unknown)\n"],
    ["member:Atom", "sort load=(&visible as any)\n"],
    ["member:Member", "sort load=(1 as number)\n"],
  ] as const)(
    "a `%s` slot: %s gives the same diagnostics with `stripTypes: false`",
    (type, source) => {
      const customTags = { sort: { attributes: { load: { type } } } };
      const byDefault = parse(source, {
        customTags,
        dialect: withAtoms,
      }).diagnostics;
      expect(
        parse(source, { customTags, dialect: withAtoms, stripTypes: false })
          .diagnostics,
      ).toEqual(byDefault);
      // The three member rows are accepted, the other two refused.
      expect(byDefault.length).toBe(
        type === "member:Member" && source.includes("&") ? 0 : 1,
      );
    },
  );

  it("a second member in one name slot is an error at the second", () => {
    const result = parse("sort asc &c &d\n");
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        message:
          "one member per slot: `&d` cannot also set `member`, which the member at 1:10 already holds",
        line: 1,
        column: 12,
      }),
    ]);
  });
});

describe("a dialect that still relies on the old member marks", () => {
  const legacy = (lowerTrigger: Dialect["lowerTrigger"]): Dialect => ({
    id: "legacy",
    name: "Legacy",
    table: {
      expressionTriggers: [MEMBER],
      attributeTriggers: [MEMBER],
    },
    lowerTrigger,
  });

  it('`ctx.attribute(name, { kind: "member" })` is a positioned error naming what to place instead', () => {
    const dialect = legacy((_id, text, span, ctx) =>
      ctx.attribute("member", {
        kind: "member",
        name: text.slice(1),
        span,
      } as never),
    );
    const result = lowerSource("sort asc &dueOn\n", "/v/entity.mx", {
      dialect,
    });
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "an attribute value is `true`, a string, a `ctx.expression` result, the trigger's own method value or a node of a registered type",
        ),
        line: 1,
        column: 9,
      }),
    ]);
  });

  it("`extra.mxMember` on an expression is not read: no `Attr.member`, no node, the mark left alone", () => {
    const dialect = legacy((_id, text, span, ctx) =>
      ctx.expression({
        type: "MemberExpression",
        object: { type: "Identifier", name: "self" },
        property: { type: "Identifier", name: text.slice(1) },
        computed: false,
        extra: { mxMember: { name: text.slice(1), span } },
      }),
    );
    const result = lowerSource("sort load=&visible\n", "/v/entity.mx", {
      dialect,
    });
    expect(result.diagnostics).toEqual([]);
    const [sort] = tags(result.ir?.body ?? []);
    const load = attrNamed(sort as SpannedTag, "load");
    if (load.kind !== "dynamic") throw new Error(load.kind);
    expect(load).not.toHaveProperty("member");
    expect(load.value.nodes).toBeUndefined();
  });
});
