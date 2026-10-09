/**
 * The `&` member shapes on the tree target (decision 182 addenda 4 and 5;
 * `notes/mesh/language-extensions-for-mesh.md` updates 03:10, 03:40, 03:42),
 * through `parseData` with core's test-only member module
 * (`packages/core/src/syntax/member.ts`, which Mesh copies)
 * loaded two ways: a temp manifest naming it in `mx.syntax`, and the
 * `syntax` option. Then the cases that must not be members, and the
 * `"member"` contract type's acceptance matrix.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomTag, SyntaxModule } from "@mxlang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ParseDataOptions, parseData } from "./parse.ts";
import type { DataAttr, DataTag } from "./tree.ts";

const MODULE = join(import.meta.dirname, "../../../core/src/syntax/member.ts");

/**
 * Loaded the way a manifest loads it (Node's strip-only `require`), not
 * imported: a static import would pull core's sources into this package's
 * typecheck.
 */
const memberSyntax = (
  createRequire(import.meta.url)(MODULE) as { default: SyntaxModule }
).default;

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-member-")));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mesh-app", mx: { syntax: MODULE } }),
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The two ways a consumer loads the module. */
const LOADERS: [string, () => [string, ParseDataOptions]][] = [
  ["a manifest naming the module", () => [join(dir, "entity.mx"), {}]],
  ["the `syntax` option", () => ["/v/entity.mx", { syntax: memberSyntax }]],
];

function tree(source: string, file: string, options: ParseDataOptions) {
  const result = parseData(source, file, options);
  expect(result.diagnostics).toEqual([]);
  return result.tree as NonNullable<typeof result.tree>;
}

function tags(nodes: readonly unknown[]): DataTag[] {
  return nodes.filter(
    (node): node is DataTag => (node as DataTag).kind === "tag",
  );
}

function attrNamed(tag: DataTag, name: string): DataAttr {
  const found = tag.attrs.find(
    (attr) => attr.kind !== "spread" && attr.name === name,
  );
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

describe.each(LOADERS)("the five Mesh cases, via %s", (_, load) => {
  it("`() => &status === :sent`: a marked `self.status`, the atom unchanged", () => {
    const [file, options] = load();
    const source = "rule check=(() => &status === :sent)\n";
    const [rule] = tags(tree(source, file, options).children);
    const check = attrNamed(rule as DataTag, "check");
    if (check.kind !== "expression") throw new Error(check.kind);
    // `code` is spliced, like the atom; the span still slices the authored text.
    expect(check.value.code).toBe('() => self.status === "sent"');
    expect(source.slice(12, 35)).toBe("() => &status === :sent");
    expect(check.value.span).toEqual({ sourceStart: 12, sourceEnd: 35 });
    expect(check.value.node).toMatchObject({
      type: "ArrowFunctionExpression",
      body: {
        type: "BinaryExpression",
        left: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "self" },
          property: { type: "Identifier", name: "status" },
          extra: {
            mxMember: {
              span: { sourceStart: 18, sourceEnd: 25 },
              name: "status",
            },
          },
        },
        right: {
          type: "StringLiteral",
          value: "sent",
          extra: { mxAtom: { span: { sourceStart: 30, sourceEnd: 35 } } },
        },
      },
    });
  });

  it("`load=[&customer, &other]`: an array of marked members", () => {
    const [file, options] = load();
    const [rule] = tags(
      tree("rule load=[&customer, &other]\n", file, options).children,
    );
    const value = attrNamed(rule as DataTag, "load");
    if (value.kind !== "expression") throw new Error(value.kind);
    expect(value.value.shape).toBe("array");
    expect(value.value.node).toMatchObject({
      type: "ArrayExpression",
      elements: [
        {
          type: "MemberExpression",
          property: { name: "customer" },
          extra: {
            mxMember: {
              span: { sourceStart: 11, sourceEnd: 20 },
              name: "customer",
            },
          },
        },
        {
          type: "MemberExpression",
          property: { name: "other" },
          extra: {
            mxMember: {
              span: { sourceStart: 22, sourceEnd: 28 },
              name: "other",
            },
          },
        },
      ],
    });
  });

  it("`sort asc &dueOn`: the static member variant, never the expression form", () => {
    const [file, options] = load();
    const [sort] = tags(tree("sort asc &dueOn\n", file, options).children);
    expect((sort as DataTag).attrs).toEqual([
      {
        kind: "boolean",
        name: "asc",
        nameSpan: { sourceStart: 5, sourceEnd: 8 },
      },
      {
        kind: "member",
        name: "member",
        value: "dueOn",
        span: { sourceStart: 9, sourceEnd: 15 },
      },
    ]);
  });

  it("`&title`: a `member` child with a static `name`", () => {
    const [file, options] = load();
    const [entity] = tags(tree("entity\n  &title\n", file, options).children);
    const [member] = tags((entity as DataTag).children);
    expect(member?.name).toBe("member");
    expect(member?.attrs).toEqual([
      {
        kind: "string",
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
    const [entity] = tags(tree(source, file, options).children);
    const [line, authored] = tags((entity as DataTag).children);
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
    const [set] = tags(tree(source, file, options).children);
    const [amount] = tags((set as DataTag).children);
    expect(amount?.trigger).toMatchObject({ id: "member", text: "&amount" });
  });

  it("`&amount=qty * price` under a concise block: a dynamic `value`, marks inside it", () => {
    const [file, options] = load();
    const source = "set\n  &title\n  &amount=qty * &price\n";
    const [set] = tags(tree(source, file, options).children);
    const members = tags((set as DataTag).children);
    expect(members.map((member) => member.name)).toEqual(["member", "member"]);
    const amount = members[1] as DataTag;
    expect(attrNamed(amount, "name")).toMatchObject({ value: "amount" });
    const value = attrNamed(amount, "value");
    if (value.kind !== "expression") throw new Error(value.kind);
    expect(value.nameSpan).toEqual({ sourceStart: 22, sourceEnd: 22 });
    expect(value.value.code).toBe("qty * self.price");
    expect(value.value.node).toMatchObject({
      type: "BinaryExpression",
      left: { type: "Identifier", name: "qty" },
      right: {
        type: "MemberExpression",
        extra: { mxMember: { name: "price" } },
      },
    });
  });
});

describe("what is not a member", () => {
  const parse = (source: string) =>
    parseData(source, "/v/entity.mx", { syntax: memberSyntax });

  it.each([
    ["`&&`", "rule x=(a && b)\n", "LogicalExpression"],
    ["`a &b`", "rule x=(a &b)\n", "BinaryExpression"],
    ["`&=`", "rule x=(a &= b)\n", "AssignmentExpression"],
  ])("%s is the operator", (_, source, type) => {
    const result = parse(source);
    expect(result.diagnostics).toEqual([]);
    const [rule] = tags(result.tree?.children ?? []);
    const x = attrNamed(rule as DataTag, "x");
    expect(x.kind === "expression" && x.value.node?.type).toBe(type);
    expect(JSON.stringify(x)).not.toContain("mxMember");
  });

  it("`&x` in a string, an expression comment and a line comment stays text", () => {
    const result = parse('// &a\nrule x="&b" y=(c /* &d */)\n');
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result.tree)).not.toContain("mxMember");
    const [rule] = tags(result.tree?.children ?? []);
    expect(attrNamed(rule as DataTag, "x")).toMatchObject({
      kind: "string",
      value: "&b",
    });
  });

  it.each([
    ["`{ &a }`", "rule v=({ &a })\n", 10],
    ["`{ &a: 1 }`", "rule v=({ &a: 1 })\n", 10],
    ["`{ &a() {} }`", "rule v=({ &a() {} })\n", 10],
  ])(
    "%s: a member is no property name (review 451 r1)",
    (_, source, column) => {
      expect(parse(source).diagnostics).toEqual([
        expect.objectContaining({
          severity: "error",
          message:
            "`&a` is not a whole operand here: the `member` trigger lowers to an expression; write it where a value stands",
          line: 1,
          column,
        }),
      ]);
    },
  );

  it("`{ [&a]: 1 }` and `{ k: &a }` are operands", () => {
    const result = parse("rule v=({ [&a]: 1, k: &b })\n");
    expect(result.diagnostics).toEqual([]);
    const [rule] = tags(result.tree?.children ?? []);
    const v = attrNamed(rule as DataTag, "v");
    expect(v.kind === "expression" && v.value.code).toBe(
      "{ [self.a]: 1, k: self.b }",
    );
  });

  it.each([
    ["x m(&a) {}\n", 4],
    ["x m(&a = 1) {}\n", 4],
    ["x m({ a: &a }) {}\n", 9],
    ["x m([&a]) {}\n", 5],
    ["x m(...&a) {}\n", 7],
  ])(
    "%j: a member in a method's parameters is refused (review 451 r2)",
    (source, column) => {
      expect(parse(source).diagnostics).toEqual([
        expect.objectContaining({
          severity: "error",
          message:
            "`&a` (the `member` trigger) cannot be declared: it lowers to an expression, and a parameter or declaration needs a plain name",
          line: 1,
          column,
        }),
      ]);
    },
  );

  it("`x m(p = &a) {}`: a member as a parameter's default is an operand", () => {
    const result = parse("x m(p = &a) {}\n");
    expect(result.diagnostics).toEqual([]);
    const [x] = tags(result.tree?.children ?? []);
    const m = attrNamed(x as DataTag, "m");
    expect(m.kind === "expression" && m.value.code).toBe(
      "function (p = self.a) {}",
    );
  });

  it("`(&a) => 1` is refused: a member cannot be declared", () => {
    expect(parse("rule x=((&a) => 1)\n").diagnostics).toEqual([
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
    const [set] = tags(result.tree?.children ?? []);
    const [member] = tags((set as DataTag).children);
    expect(attrNamed(member as DataTag, "name")).toMatchObject({ value: "a" });
    expect(attrNamed(member as DataTag, "value")).toMatchObject({
      kind: "expression",
      value: {
        code: "1",
        span: { sourceStart: valueStart, sourceEnd: valueStart + 1 },
      },
    });
  });

  it.each(["sort asc &a=1\n", "sort asc &a(x) { return 1 }\n"])(
    "%j: after a kind a member takes no value (review 460 F6)",
    (source) => {
      expect(parse(source).diagnostics).toEqual([
        expect.objectContaining({
          message: "`&a` is a member reference and takes no value",
          line: 1,
          column: 9,
        }),
      ]);
    },
  );
});

describe('the `"member"` contract type (decision 182 addendum 4)', () => {
  const contract = (type: "member" | "atom" | "expression"): CustomTag => ({
    attributes: { slot: { type } },
  });
  const run = (type: "member" | "atom" | "expression", value: string) =>
    parseData(`sort ${value}\n`, "/v/entity.mx", {
      syntax: {
        ...memberSyntax,
        // The member lands in the declared slot.
        lowerTrigger: (_id, text, span, ctx) =>
          ctx.attribute("slot", { kind: "member", name: text.slice(1), span }),
      },
      customTags: { sort: contract(type) },
    }).diagnostics.map((diagnostic) => diagnostic.message);

  it("`member` accepts a member", () => {
    expect(run("member", "&dueOn")).toEqual([]);
  });

  it("`expression` accepts a member", () => {
    expect(run("expression", "&dueOn")).toEqual([]);
  });

  it("`atom` refuses a member", () => {
    expect(run("atom", "&dueOn")).toEqual([
      expect.stringContaining("attribute `slot` must be an atom, got a member"),
    ]);
  });

  it.each([
    ["an atom", "slot=:dueOn"],
    ["a string", 'slot="dueOn"'],
    ["an expression", "slot=(a.b)"],
    ["a bare attribute", "slot"],
  ])("`member` refuses %s", (got, value) => {
    expect(run("member", value)).toEqual([
      expect.stringContaining(
        `attribute \`slot\` must be a member, got ${got}`,
      ),
    ]);
  });

  it.each(["values", "pattern", "ref"] as const)(
    "`%s` stays atom-only",
    (key) => {
      const result = parseData("sort &a\n", "/v/entity.mx", {
        syntax: memberSyntax,
        customTags: {
          sort: {
            attributes: {
              member: {
                type: "member",
                [key]:
                  key === "values" ? ["a"] : key === "pattern" ? "^a$" : "kind",
              },
            },
          },
        },
      });
      expect(result.diagnostics.map((d) => d.message)).toEqual([
        expect.stringContaining(`\`${key}\` requires \`type: "atom"\``),
      ]);
    },
  );
});

describe("the unknown-tag scan takes the module too (PR 450's parseMxDocument)", () => {
  it("after a lowering error, the scan still finds an unknown tag beside members", () => {
    // The scan runs only when lowering fails (`asc=1` against a boolean).
    const result = parseData("sort &a asc=1\nfoo\n", "/v/entity.mx", {
      syntax: memberSyntax,
      unknownTags: "reject",
      customTags: {
        sort: {
          attributes: { asc: { type: "boolean" }, member: { type: "member" } },
        },
      },
    });
    const messages = result.diagnostics.map((d) => d.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("attribute `asc` must be boolean");
    expect(messages[1]).toContain("`<foo>`");
  });
});

describe("Mesh review of PR 451 (M1, M4, M5, one member per slot)", () => {
  const parse = (source: string, options: ParseDataOptions = {}) =>
    parseData(source, "/v/entity.mx", { syntax: memberSyntax, ...options });
  const codeOf = (source: string, pick: (tag: DataTag) => unknown) => {
    const result = parse(source);
    expect(result.diagnostics).toEqual([]);
    return pick(tags(result.tree?.children ?? [])[0] as DataTag);
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
        return attr?.kind === "expression" && attr.value.code;
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

  const slot = (type: "member" | "atom", source: string) =>
    parse(source, {
      customTags: { sort: { attributes: { load: { type } } } },
    }).diagnostics.map((d) => d.message);

  it("M5: a `member` slot accepts a dynamic value that is one member", () => {
    expect(slot("member", "sort load=&visible\n")).toEqual([]);
  });

  it("M5: a `member` slot refuses an expression around a member", () => {
    expect(slot("member", "sort load=(&visible && x)\n")).toEqual([
      expect.stringContaining(
        "attribute `load` must be a member, got an expression",
      ),
    ]);
  });

  it("M5: an `atom` slot refuses the dynamic form too", () => {
    expect(slot("atom", "sort load=&visible\n")).toEqual([
      expect.stringContaining("attribute `load` must be an atom, got a member"),
    ]);
  });

  it("a second member in one name slot is an error at the second", () => {
    expect(parse("sort asc &c &d\n").diagnostics).toEqual([
      expect.objectContaining({
        message:
          "one member per slot: `member` already holds `c`, so this member cannot also set it",
        line: 1,
        column: 12,
      }),
    ]);
  });
});
