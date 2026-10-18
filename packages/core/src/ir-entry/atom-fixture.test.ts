/**
 * A dialect's atoms are a node type of its own; core has no atom syntax, no
 * atom IR and no atom contract type. These pin what core does with a node a
 * dialect registers, through the atom fixture dialect
 * (`../fixtures/syntax/atom-fixture.ts`, node type `atom:Atom`, sigil `~`),
 * loaded two ways: a dialect package naming it in `mx.dialect.module`, and
 * the `dialect` option.
 *
 * 1. A node reaches the IR as `Attr.node` (a whole value) or as an
 *    `Expr.nodes` entry (inside an expression), with its type, span, the
 *    node, its forward and the forward's printed range.
 * 2. The `LoweredUnit` view hands a module the node itself (a whole value)
 *    or `mx:Expression` with `nodes`; `ContractMember` and
 *    `ContractExpression.nodes` type it.
 * 3. A contract `type` (or `items`) naming a node type key accepts a node of
 *    that type and refuses anything else, in one positioned diagnostic; a
 *    key the dialect does not register, or one beside `enum`, is a
 *    registration error.
 * 4. `ctx.declare` still works for a module.
 * 5. `values`, `pattern`, `ref` and `declares` are the module's to claim.
 * 6. `mappedExpr` maps each node to its forward (typecheck).
 * 7. A mark a dialect sets on its forward (`extra.mxAtom`) reaches every
 *    later reader unchanged; core no longer reads it.
 * 8. A node placed by `ctx.attribute` lowers through its type; a node of a
 *    type the dialect does not register is a positioned error.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSource } from "../compile.ts";
import type { CustomTag } from "../custom-tags.ts";
import type { HostDeclarations } from "../declarations.ts";
import type { Attr, Expr, ExprNode } from "../ir.ts";
import type {
  ContractAttr,
  ContractExpression,
  ContractMember,
  ContractValue,
  LoweredUnit,
} from "../lowered-unit.ts";
import { mappedExpr } from "../mapping.ts";
import { scanCustomTags } from "../scan.ts";
import type { Dialect } from "../syntax-table.ts";
import { testTargetLookup } from "../test-targets.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";
import { dialectPackage } from "./test-dialect-package.ts";

const MODULE = join(import.meta.dirname, "../fixtures/syntax/atom-fixture.ts");

/** Loaded the way a dialect package's module loads (Node's strip-only `require`). */
const atomSyntax = (
  createRequire(import.meta.url)(MODULE) as { default: Dialect }
).default;

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-atom-")));
  dialectPackage(dir, MODULE, {
    id: "atom",
    name: "Fixture",
    extensions: [".atom.mx"],
  });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The two ways a consumer loads the module. */
const LOADERS: [string, () => [string, LowerSourceOptions]][] = [
  ["a dialect package", () => [join(dir, "entity.atom.mx"), {}]],
  ["the `dialect` option", () => ["/v/entity.mx", { dialect: atomSyntax }]],
];

const tags = (customTags: Record<string, unknown>) =>
  customTags as Record<string, CustomTag>;

/** The tag-call shape the view pins use: `mode` and `name` are atom slots. */
const PICK = tags({
  pick: {
    attributes: {
      mode: { type: "atom:Atom", values: ["on", "off"] },
      n: {},
      name: { type: "atom:Atom" },
    },
  },
});

function messages(
  source: string,
  customTags: Record<string, CustomTag>,
  options: LowerSourceOptions = { dialect: atomSyntax },
): string[] {
  return lowerSource(source, "/v/entity.mx", {
    ...options,
    customTags,
  }).diagnostics.map((each) => each.message);
}

/** The first node's attributes, from a lowering that must not fail. */
function attrsWith(source: string, file: string, options: LowerSourceOptions) {
  const result = lowerSource(source, file, options);
  expect(result.diagnostics).toEqual([]);
  const node = result.ir?.body[0] as unknown as {
    tag?: { attrs: Attr[] };
    attrs?: Attr[];
  };
  return node.tag?.attrs ?? node.attrs ?? [];
}

function dynamicOf(attr: Attr | undefined): Expr {
  if (attr?.kind !== "dynamic") throw new Error(String(attr?.kind));
  return attr.value;
}

describe.each(LOADERS)("a dialect's node in the IR, via %s", (_, load) => {
  const attrsOf = (source: string): Attr[] => {
    const [file, options] = load();
    return attrsWith(source, file, options);
  };

  it("a whole `=value` is a static attribute carrying the node", () => {
    const [mode] = attrsOf("<div mode=~on/>\n");
    expect(mode).toMatchObject({
      kind: "static",
      name: "mode",
      value: "on",
      node: {
        type: "atom:Atom",
        name: "on",
        span: { sourceStart: 10, sourceEnd: 13 },
      },
    });
    expect(mode && "atom" in mode).toBe(false);
  });

  it("an attribute-list `~name` is the static `name` attribute carrying the node it placed", () => {
    const [name] = attrsOf("thing ~title\n");
    expect(name && "sugar" in name).toBe(false);
    expect(name).toMatchObject({
      kind: "static",
      name: "name",
      value: "title",
      node: {
        type: "atom:Atom",
        name: "title",
        span: { sourceStart: 6, sourceEnd: 12 },
      },
    });
  });

  it("a node inside an expression is an `Expr.nodes` entry: type, span, node, forward and printed range", () => {
    const value = dynamicOf(attrsOf("<div v=(a + ~b)/>\n")[0]);
    expect(value.code).toBe('a + "b"');
    const right = (value.node as { right: { type: string; extra: object } })
      .right;
    // The forward is a plain literal: core marks nothing.
    expect(right).toMatchObject({ type: "StringLiteral", value: "b" });
    expect(right.extra).not.toHaveProperty("mxAtom");
    expect(value.nodes).toHaveLength(1);
    const [entry] = value.nodes as ExprNode[];
    expect(entry).toMatchObject({
      type: "atom:Atom",
      span: { sourceStart: 12, sourceEnd: 14 },
      node: { type: "atom:Atom", name: "b" },
      code: { start: 4, end: 7 },
    });
    // The forward is the very node `Expr.node` holds in the node's place.
    expect(entry?.forward).toBe(right);
    expect(value.code.slice(entry?.code?.start, entry?.code?.end)).toBe('"b"');
    expect(Object.isFrozen(entry?.node)).toBe(true);
  });

  it("positions after a node are the printed ones, every node in source order", () => {
    const value = dynamicOf(attrsOf("<div v=[~a, x, ~rename-all, y]/>\n")[0]);
    expect(value.code).toBe('["a", x, "rename-all", y]');
    expect(
      (value.nodes ?? []).map((each) => [
        each.type,
        (each.node as unknown as { name: string }).name,
        each.span,
        value.code.slice(each.code?.start, each.code?.end),
      ]),
    ).toEqual([
      ["atom:Atom", "a", { sourceStart: 8, sourceEnd: 10 }, '"a"'],
      [
        "atom:Atom",
        "rename-all",
        { sourceStart: 15, sourceEnd: 26 },
        '"rename-all"',
      ],
    ]);
  });

  it("a method value, printed from its function, still lists its nodes, with no printed range", () => {
    const [attr] = attrsOf(
      "<div onClick(e) { const x = ~a; return [x, ~b] }/>\n",
    );
    const value = (attr as { value: Expr }).value;
    expect(value.code).toContain('"a"');
    expect(value.code).toContain('"b"');
    expect(
      (value.nodes ?? []).map((each) => [
        (each.node as unknown as { name: string }).name,
        each.span,
        "code" in each,
      ]),
    ).toEqual([
      ["a", { sourceStart: 28, sourceEnd: 30 }, false],
      ["b", { sourceStart: 43, sourceEnd: 45 }, false],
    ]);
    // Each forward is still the very node the payload holds.
    const literals: unknown[] = [];
    JSON.stringify(value.node, (_key, each) => {
      if (each?.type === "StringLiteral") literals.push(each);
      return each;
    });
    for (const each of value.nodes ?? []) {
      expect(literals).toContain(each.forward);
    }
  });

  it("an expression with no node has no `nodes` field", () => {
    const value = dynamicOf(attrsOf("<div v=[1, x]/>\n")[0]);
    expect("nodes" in value).toBe(false);
  });
});

describe("the `LoweredUnit` view of a dialect's node", () => {
  const host: HostDeclarations = {
    tags: {},
    isElement: () => true,
    isComponent: () => false,
    isDelegatedTag: () => true,
    resolveDefaultTag: () => "setter",
    attrTags: 2,
  };

  /** The unit the fixture's own `afterLower` was handed, besides its check. */
  function unitOf(
    source: string,
    customTags: Record<string, CustomTag>,
    dialect: Dialect = atomSyntax,
  ) {
    let seen: LoweredUnit | undefined;
    compileSource(source, "/v/page.mx", host, {
      targets: testTargetLookup(),
      customTags,
      tagDiscoveryDirs: [],
      dialect: {
        ...dialect,
        afterLower: (unit) => {
          seen = unit;
        },
      },
      emitIr: () => "",
    });
    if (!seen) throw new Error("afterLower did not run");
    return seen;
  }

  const attrOf = (attrs: readonly ContractAttr[] | undefined, name: string) => {
    const found = attrs?.find(
      (each) => !("spread" in each) && each.name === name,
    );
    if (!found || "spread" in found) throw new Error(`no attribute ${name}`);
    return found;
  };

  it("a whole value is the node, an expression lists its nodes, frozen", () => {
    const source = "<pick mode=~on n=(x + ~y)/>\n<pick ~named/>";
    const unit = unitOf(source, PICK);
    const [first, second] = unit.calls;
    const mode = attrOf(first?.attrs, "mode");
    expect(mode.value).toMatchObject({
      type: "atom:Atom",
      name: "on",
      span: { sourceStart: 11, sourceEnd: 14 },
    });
    expect(Object.isFrozen(mode)).toBe(true);
    expect(Object.isFrozen(mode.value)).toBe(true);
    // Inside an expression the node is an entry of the expression's `nodes`.
    const n = attrOf(first?.attrs, "n");
    expect(n.value).toMatchObject({ type: "mx:Expression", code: 'x + "y"' });
    const nodes = (n.value as ContractExpression).nodes ?? [];
    expect(nodes.map((each) => [each.type, each.span])).toEqual([
      ["atom:Atom", { sourceStart: 22, sourceEnd: 24 }],
    ]);
    expect(nodes[0]?.forward).toBe(
      (n.value as { node: { right: object } }).node.right,
    );
    // The attribute-list form is the static `name` attribute, its node the value.
    expect(attrOf(second?.attrs, "name")).toEqual({
      name: "name",
      nameSpan: { sourceStart: 34, sourceEnd: 40 },
      label: "`name`",
      value: expect.objectContaining({ type: "atom:Atom", name: "named" }),
    });
  });

  it("`ContractMember` and `ContractExpression.nodes` type what the view hands a module", () => {
    const unit = unitOf("<pick mode=~on n=[~a]/>", PICK);
    const value: ContractValue | null | undefined = attrOf(
      unit.calls[0]?.attrs,
      "mode",
    ).value;
    // A type-level pin: a member is one arm of `ContractValue`; a dialect's
    // node is another, which `type` does not narrow, so a module checks the
    // key and casts.
    const member: ContractMember = {
      type: "mx:Member",
      name: "x",
      span: { sourceStart: 0, sourceEnd: 2 },
    };
    const asValue: ContractValue[] = [member];
    expect(asValue).toHaveLength(1);
    expect(value?.type).toBe("atom:Atom");
    const n = attrOf(unit.calls[0]?.attrs, "n").value as ContractExpression;
    const nodes: readonly ExprNode[] | undefined = n.nodes;
    const kind: `${string}:${string}` | undefined = nodes?.[0]?.type;
    expect(kind).toBe("atom:Atom");
  });

  it("a mark the dialect sets on its forward reaches `afterLower` unchanged; core reads none", () => {
    // Marks stay for 0.1.0-alpha.33 and go in 0.1.0-alpha.34: a dialect
    // that still sets `extra.mxAtom` on its forward (Mesh's atoms do, in
    // this release) gets it back on the same node, untouched.
    const marks: object[] = [];
    const marking: Dialect = {
      ...atomSyntax,
      nodeTypes: {
        Atom: {
          keys: [],
          parse: (text: string) => ({ name: text.slice(1) }),
          print: (node: { name: string }) => `~${node.name}`,
          lower: (node: { name: string; span: object }, ctx) => {
            const mark = Object.freeze({ span: node.span, name: node.name });
            marks.push(mark);
            return ctx.expression({
              type: "StringLiteral",
              value: node.name,
              extra: {
                raw: JSON.stringify(node.name),
                rawValue: node.name,
                mxAtom: mark,
              },
            });
          },
        },
      },
    };
    const unit = unitOf("<pick n=(x + ~y) mode=~on/>", PICK, marking);
    const n = attrOf(unit.calls[0]?.attrs, "n").value as ContractExpression;
    const right = (n.node as { right: { extra: { mxAtom: unknown } } }).right;
    expect(marks).toHaveLength(2);
    expect(right.extra.mxAtom).toBe(marks[0]);
    expect(n.nodes?.[0]?.forward).toBe(right);
    // The IR the host emits holds the same node, mark and all.
    const [, attr] = attrsWith("<div mode=~on n=(x + ~y)/>\n", "/v/a.mx", {
      dialect: marking,
    });
    const forward = (dynamicOf(attr).node as { right: { extra: object } })
      .right;
    expect(forward.extra).toMatchObject({ mxAtom: { name: "y" } });
  });
});

describe("a contract `type` naming a node type key", () => {
  const MODE = tags({
    pick: { attributes: { mode: { type: "atom:Atom" }, other: {} } },
  });
  /** A dialect that registers the type and writes no atom: the check is core's. */
  const quiet: Dialect = {
    id: "atom",
    name: "Fixture",
    table: {},
    nodeTypes: atomSyntax.nodeTypes,
  };

  it.each([
    ["a whole-value node", "<pick mode=~on/>"],
    ["a node in parentheses (its forward)", "<pick mode=(~on)/>"],
    ["an identifier (no knowable type)", "<pick mode=x/>"],
    ["an attribute-list node", "pick ~on\n"],
  ])("accepts %s", (_, source) => {
    const tagsFor = source.startsWith("pick ")
      ? tags({ pick: { attributes: { name: { type: "atom:Atom" } } } })
      : MODE;
    expect(messages(source, tagsFor)).toEqual([]);
  });

  it.each([
    ["a string", '<pick mode="on"/>', "got string"],
    ["a number", "<pick mode=1/>", "got number"],
    ["a function", "<pick mode=(() => 1)/>", "got function"],
    ["an array of nodes", "<pick mode=[~a, ~b]/>", "got array"],
  ])("refuses %s, naming the value, in core's words", (_, source, got) => {
    const expected = `\`<pick>\`: attribute \`mode\` must be atom:Atom, ${got}`;
    expect(messages(source, MODE)).toEqual([expected]);
    if (source.includes("~")) return;
    expect(messages(source, MODE, { dialect: quiet })).toEqual([expected]);
  });

  it("`items` names a node type: each element is checked", () => {
    const LIST = tags({
      pick: { attributes: { list: { type: "array", items: "atom:Atom" } } },
    });
    expect(messages("<pick list=[~a, ~b]/>", LIST)).toEqual([]);
    expect(messages('<pick list=[~a, "b", x]/>', LIST)).toEqual([
      "`<pick>`: attribute `list` item 2 must be atom:Atom, got string",
    ]);
  });

  it("a node of the type against a string slot is refused, naming the type", () => {
    const S = tags({ pick: { attributes: { s: { type: "string" } } } });
    expect(messages("<pick s=~on/>", S)).toEqual([
      "`<pick>`: attribute `s` must be string, got atom:Atom",
    ]);
  });

  it("a key the file's dialect does not register is a registration error", () => {
    const unknown = tags({
      pick: { attributes: { mode: { type: "atom:Nope" } } },
    });
    const [problem] = lowerSource("<pick/>", "/v/entity.mx", {
      dialect: atomSyntax,
      customTags: unknown,
    }).diagnostics;
    expect(problem?.code).toBe("MX_INVALID_CONTRACT");
    expect(problem?.message).toContain(
      '`type: "atom:Nope"` is not a node type the file\'s dialect registers (it registers `atom:Atom`)',
    );
    // With no dialect nothing is registered.
    expect(
      messages(
        "<pick/>",
        tags({ pick: { attributes: { mode: { type: "atom:Atom" } } } }),
        {},
      )[0],
    ).toContain(
      '`type: "atom:Atom"` is not a node type the file\'s dialect registers (it registers none)',
    );
    expect(
      messages(
        "<pick/>",
        tags({
          pick: {
            attributes: { list: { type: "array", items: "atom:Nope" } },
          },
        }),
      )[0],
    ).toContain('`items: "atom:Nope"` is not a node type');
  });

  it("a `type` core does not have is a registration error; the removed `atom` names the fix", () => {
    const old = tags({ pick: { attributes: { mode: { type: "atom" } } } });
    const [problem] = lowerSource("<pick/>", "/v/entity.mx", {
      dialect: atomSyntax,
      customTags: old,
    }).diagnostics;
    expect(problem?.code).toBe("MX_INVALID_CONTRACT");
    expect(problem?.message).toContain(
      'Invalid "mode" attribute declaration of tag "pick": `type: "atom"` was removed; declare a node type the file\'s dialect registers (`atom:Atom`), or `{ type: "array", items: "atom:Atom" }` for a list',
    );
    expect(
      messages(
        "<pick/>",
        tags({ pick: { attributes: { mode: { type: "atom" } } } }),
        {},
      )[0],
    ).toContain(
      '`type: "atom"` was removed; declare a node type the file\'s dialect registers (`dialect:Type`)',
    );
    expect(
      messages(
        "<pick/>",
        tags({ pick: { attributes: { mode: { type: "object" } } } }),
      )[0],
    ).toContain(
      '`type: "object"` is not a type; use one of string, number, boolean, expression, array, function, member, or a node type the file\'s dialect registers (`atom:Atom`)',
    );
  });

  it("`enum` beside a node type is a registration error", () => {
    const both = tags({
      pick: { attributes: { mode: { type: "atom:Atom", enum: ["on"] } } },
    });
    expect(messages("<pick/>", both)[0]).toContain(
      '`enum` cannot be combined with `type: "atom:Atom"`',
    );
  });
});

describe("where core's `type` check reports, and what it names", () => {
  const at = (source: string, customTags: Record<string, CustomTag>) =>
    lowerSource(source, "/v/entity.mx", {
      dialect: atomSyntax,
      customTags,
    }).diagnostics.map((each) => `${each.line}:${each.column} ${each.message}`);
  const SLOTS = tags({
    pick: {
      attributes: {
        mode: { type: "atom:Atom" },
        list: { type: "array", items: "atom:Atom" },
        s: { type: "string" },
        n: { type: "number" },
      },
      attributeTags: { row: { attributes: { mode: { type: "atom:Atom" } } } },
    },
  });

  it.each([
    [
      "<pick s=~on/>",
      "1:8 `<pick>`: attribute `s` must be string, got atom:Atom",
    ],
    [
      "<pick n=~on/>",
      "1:8 `<pick>`: attribute `n` must be number, got atom:Atom",
    ],
    [
      "<pick s=(~on)/>",
      "1:9 `<pick>`: attribute `s` must be string, got atom:Atom",
    ],
    [
      "<pick list=[~a, 2]/>",
      "1:16 `<pick>`: attribute `list` item 2 must be atom:Atom, got number",
    ],
    [
      '<pick mode="on"/>',
      "1:11 `<pick>`: attribute `mode` must be atom:Atom, got string",
    ],
    [
      "<pick mode=1/>",
      "1:11 `<pick>`: attribute `mode` must be atom:Atom, got number",
    ],
    [
      '<pick><@row mode="x"/></pick>',
      "1:17 `<pick>`: `<@row>`: attribute `mode` must be atom:Atom, got string",
    ],
    [
      "<pick list=~a/>",
      "1:11 `<pick>`: attribute `list` must be array, got atom:Atom; write it as a list: `[~a]`",
    ],
    [
      "<pick list=(~a)/>",
      "1:12 `<pick>`: attribute `list` must be array, got atom:Atom; write it as a list: `[~a]`",
    ],
    [
      '<pick list="a"/>',
      "1:11 `<pick>`: attribute `list` must be array, got string",
    ],
    [
      "<pick list=1/>",
      "1:11 `<pick>`: attribute `list` must be array, got number",
    ],
  ])("%s is refused once, at the value: %s", (source, expected) => {
    expect(at(source, SLOTS)).toEqual([expected]);
  });

  it("a list slot whose declaration uses a claimed key words its errors like a one-node slot", () => {
    const BOX = tags({
      box: {
        attributes: {
          one: { type: "atom:Atom", values: ["a", "b"] },
          list: { type: "array", items: "atom:Atom", values: ["a", "b"] },
        },
      },
    });
    expect(at('<box one="a"/>', BOX)).toEqual([
      "1:9 `<box>`: attribute `one` must be atom:Atom, got string (one of ~a, ~b)",
    ]);
    expect(at('<box list="a"/>', BOX)).toEqual([
      "1:10 `<box>`: attribute `list` must be array, got string (one of ~a, ~b)",
    ]);
    expect(at("<box list=1/>", BOX)).toEqual([
      "1:10 `<box>`: attribute `list` must be array, got number (one of ~a, ~b)",
    ]);
    expect(at('<box list=[~a, "b"]/>', BOX)).toEqual([
      "1:15 `<box>`: attribute `list` item 2 must be atom:Atom, got string (one of ~a, ~b)",
    ]);
    expect(at("<box list=~a/>", BOX)).toEqual([
      "1:10 `<box>`: attribute `list` must be array, got atom:Atom; write it as a list: `[~a]`",
    ]);
    expect(at("<box list=[~a, ~b]/>", BOX)).toEqual([]);
  });
});

describe("a node a hook places with `ctx.attribute`", () => {
  const placing = (type: string): Dialect => ({
    ...atomSyntax,
    lowerTrigger: (_id, text, span, ctx) =>
      ctx.attribute("name", {
        type: type as `${string}:${string}`,
        name: text.slice(1),
        span,
      }),
  });

  it("lowers through its type's `lower`, like a claimed value", () => {
    const [name] = attrsWith("thing ~title\n", "/v/a.mx", {
      dialect: placing("atom:Atom"),
    });
    expect(name).toMatchObject({
      kind: "static",
      value: "title",
      node: { type: "atom:Atom", name: "title" },
    });
  });

  it("of a type the dialect does not register is a positioned error, never a silent drop", () => {
    const [problem, ...rest] = lowerSource("thing ~title\n", "/v/a.mx", {
      dialect: placing("atom:Nope"),
    }).diagnostics;
    expect(rest).toEqual([]);
    expect(problem).toMatchObject({ line: 1, column: 6 });
    expect(problem?.message).toContain(
      "the attribute value is a `atom:Nope` node, which is not a node type the dialect registers (it registers `atom:Atom`)",
    );
  });
});

describe("`ctx.declare` for a module", () => {
  it("an `analyze` hook's declaration reaches the unit a module's `afterLower` reads", () => {
    const seen: unknown[] = [];
    const analyzed: Record<string, CustomTag> = {
      item: {
        analyze(calls, ctx) {
          for (const call of calls) {
            if (call.span) {
              ctx.declare("node", "made", {
                span: call.span,
                scope: ["group"],
              });
            }
          }
        },
      },
      group: {},
    };
    lowerSource("<group><item/></group>", "/v/entity.mx", {
      dialect: {
        ...atomSyntax,
        afterLower: (unit) => {
          seen.push(...unit.declared);
        },
      },
      customTags: analyzed,
    });
    expect(seen).toEqual([
      {
        kind: "node",
        name: "made",
        span: { sourceStart: 7, sourceEnd: 14 },
        scope: ["group"],
      },
    ]);
  });
});

/**
 * The keys core does not know. The first three are attribute keys, refused
 * by the attribute unknown-key check; `declares` is a tag key, refused by its
 * own pin below.
 */
const FOUR_KEYS: [string, Record<string, CustomTag>, string][] = [
  [
    "values",
    tags({ box: { attributes: { mode: { type: "string", values: ["a"] } } } }),
    'Unknown key "values" in the "mode" attribute declaration of tag "box"',
  ],
  [
    "pattern",
    tags({ box: { attributes: { mode: { type: "string", pattern: "^a$" } } } }),
    'Unknown key "pattern" in the "mode" attribute declaration of tag "box"',
  ],
  [
    "ref",
    tags({ box: { attributes: { mode: { type: "string", ref: "node" } } } }),
    'Unknown key "ref" in the "mode" attribute declaration of tag "box"',
  ],
];

describe("`values`, `pattern` and `ref` belong to the module that claims them, `declares` too", () => {
  const none: Dialect = { id: "plain", name: "Fixture", table: {} };

  it.each(FOUR_KEYS)(
    "`%s` without a claiming module is the unknown-key error",
    (_key, customTags, message) => {
      for (const dialect of [none, undefined]) {
        const result = messages("<box/>", customTags, {
          ...(dialect ? { dialect } : {}),
        });
        expect(result).toHaveLength(1);
        expect(result[0]).toContain(message);
      }
    },
  );

  it.each(FOUR_KEYS)(
    "`%s` is accepted, as data, once a module claims it",
    (key, customTags) => {
      const claimsOnly: Dialect = {
        ...none,
        contractFields: { attribute: [key] },
      };
      expect(messages("<box/>", customTags, { dialect: claimsOnly })).toEqual(
        [],
      );
    },
  );

  it("`declares` reaches a module only when it claims it; unclaimed it is the unknown-key error", () => {
    const declared = tags({ box: { declares: { kind: "node", from: "id" } } });
    const contractOf = (dialect: Dialect) => {
      let seen: unknown;
      lowerSource("<box/>", "/v/entity.mx", {
        dialect: {
          ...dialect,
          afterLower: (unit) => {
            seen = unit.calls[0]?.contract;
          },
        },
        customTags: declared,
      });
      return seen;
    };
    expect(
      contractOf({ ...none, contractFields: { tag: ["declares"] } }),
    ).toEqual({ declares: { kind: "node", from: "id" } });
    const refusal =
      "`<box>`: `declares` is not allowed: no syntax module claims it (`contractFields`)";
    for (const dialect of [none, undefined]) {
      expect(messages("<box/>", declared, dialect ? { dialect } : {})).toEqual([
        refusal,
      ]);
    }
  });

  it("an unclaimed `declares` is refused from a sidecar and from `mx.contracts` too", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mx-declares-")));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      mkdirSync(join(root, "tags"));
      writeFileSync(
        join(root, "tags", "box.tag.ts"),
        'export default { declares: { kind: "node", from: "id" }, transform: () => [] };',
      );
      const sidecar = () =>
        // A sidecar loads on its first read of a declared key.
        (
          scanCustomTags(join(root, "page.mx"), { targets: testTargetLookup() })
            .customTags.box as CustomTag
        ).attributes;
      expect(sidecar).toThrow("`declares` is not allowed");
      rmSync(join(root, "tags"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ mx: { contracts: "./c.ts" } }),
      );
      writeFileSync(
        join(root, "c.ts"),
        'export default { box: { declares: { kind: "node", from: "id" } } };',
      );
      expect(() =>
        scanCustomTags(join(root, "page.mx"), { targets: testTargetLookup() }),
      ).toThrow(
        "`<box>`: `declares` is not allowed: no syntax module claims it",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the fixture's first error is the file's, ahead of core's shape error on a later call", () => {
    const box = tags({
      box: {
        attributes: { mode: { type: "atom:Atom", values: ["on", "off"] } },
      },
    });
    expect(messages('<box mode=~zz/>\n<box mode="red"/>', box)).toEqual([
      "`<box>`: attribute `mode`: `~zz` is not one of ~on, ~off",
    ]);
    // Alone, the string is core's deferred shape error, in the module's words.
    expect(messages('<box mode="red"/>', box)).toEqual([
      "`<box>`: attribute `mode` must be atom:Atom, got string (one of ~on, ~off)",
    ]);
  });

  it("under the fixture its own checks run and core runs none", () => {
    const box = tags({
      box: {
        attributes: {
          mode: { type: "atom:Atom", values: ["on", "off"], pattern: "^o" },
          link: { type: "atom:Atom", ref: "node" },
        },
        declares: { kind: "node", from: "id" },
      },
    });
    // The fixture's `afterLower`, not a core check.
    expect(messages("<box mode=~zz/>", box)).toEqual([
      "`<box>`: attribute `mode`: `~zz` is not one of ~on, ~off",
    ]);
    // `pattern`, `ref` and `declares` are carried and never checked: a
    // pattern the atom fails, a reference nothing declares, two declarations
    // of one name.
    expect(
      messages("<box mode=~on link=~nowhere/>\n<box mode=~off/>", box),
    ).toEqual([]);
    // The fixture's `checkContract` replaces core's registration checks.
    const malformed = tags({
      box: { attributes: { mode: { type: "atom:Atom", values: 5 } } },
    });
    expect(messages("<box/>", malformed)).toEqual([
      "`<box>`: `mode`: `values` must be an array of strings",
    ]);
  });
});

describe("the per-node source mapping (typecheck)", () => {
  const dynamicValue = (source: string) =>
    dynamicOf(attrsWith(source, "/v/entity.mx", { dialect: atomSyntax })[0]);

  it("maps each node to its forward and the text between one to one", () => {
    const source = "<div x=[~a, ~rename-all]/>\n";
    const { code, mappings } = mappedExpr(dynamicValue(source));
    expect(code).toBe('["a", "rename-all"]');
    expect(
      mappings.map((m) => [
        source.slice(m.sourceStart, m.sourceEnd),
        code.slice(m.generatedStart, m.generatedEnd),
      ]),
    ).toEqual([
      ["[", "["],
      ["~a", '"a"'],
      [", ", ", "],
      ["~rename-all", '"rename-all"'],
      ["]", "]"],
    ]);
  });

  it("an expression without nodes keeps its one whole mapping", () => {
    const value = dynamicValue("<div x=[1, 2]/>\n");
    expect(mappedExpr(value).mappings).toEqual([
      { sourceStart: 7, sourceEnd: 13, generatedStart: 0, generatedEnd: 6 },
    ]);
  });
});
