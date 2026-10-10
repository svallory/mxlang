/**
 * The attribute value position runs the one claim process: a `valueTriggers`
 * row armed on the value's first character, whose `match` covers the whole
 * value the parser read, names a registered node type (`mx:String`,
 * `mx:Expression` or the dialect's own). The type's `parse` returns the
 * node, which becomes `MxAttribute.value`, or `undefined`, which leaves the
 * value as if no row matched. The node rides on the IR attribute
 * (`Attr.node`) and is the attribute's value in the contract view
 * (`ContractAttr.value`). A claimed value also ends where a terminating
 * attribute row starts, which is how `belongs-to=:List :list` reads.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSource, parseMxDocument } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { CustomTag } from "./custom-tags.ts";
import type { DialectNode, NodeType } from "./dialect-registry.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { lowerSource } from "./ir-entry/index.ts";
import type { ContractAttr, LoweredUnit } from "./lowered-unit.ts";
import type { Dialect, Trigger } from "./syntax-table.ts";
import { lookup as targets } from "./test-targets.ts";

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

interface Ref extends DialectNode {
  readonly path: readonly string[];
}

/** `~user.name` as a whole attribute value. */
const REF: Trigger = {
  id: "ref",
  chars: "~",
  match: "~[a-z]+(?:\\.[a-z]+)*",
  standIn: "identifier",
  node: { type: "Ref", dialect: "ref" },
};

const RefType: NodeType<Ref> = {
  keys: [],
  // `~skip…` declines: the value parses as if no row matched.
  parse: (text) =>
    text.startsWith("~skip") ? undefined : { path: text.slice(1).split(".") },
  print: (node) => `~${node.path.join(".")}`,
  lower: (node) => node.path.join("."),
};

const REF_DIALECT: Dialect = {
  id: "ref",
  name: "Ref",
  table: { valueTriggers: [REF] },
  nodeTypes: { Ref: RefType },
};

/** A dialect whose one value row names `type` (in `dialect`), on `chars`, matching `match`. */
function valueRow(
  type: string,
  dialect: string,
  chars = "~",
  match = REF.match,
): Dialect {
  return {
    ...REF_DIALECT,
    table: {
      valueTriggers: [{ ...REF, chars, match, node: { type, dialect } }],
    },
  };
}

/** `"…"` and `'…'` values and bare `h…` words are strings. */
const STRINGS: Dialect = {
  id: "str",
  name: "Str",
  table: {
    valueTriggers: [
      {
        id: "string",
        chars: "\"'h",
        match: `"(?:[^"\\\\]|\\\\[^])*"|'(?:[^'\\\\]|\\\\[^])*'|h[a-z]*`,
        standIn: "keep",
        node: { type: "String", dialect: "mx" },
      },
    ],
  },
};

function treeOf(source: string, dialect?: Dialect): unknown {
  const document = parseMxDocument(source, "page.mx", undefined, dialect) as
    | { body: unknown }
    | undefined;
  if (!document) throw new Error("the template did not parse");
  return JSON.parse(JSON.stringify(document.body));
}

type MxAttr = { type: string; name: string; value: Record<string, unknown> };

function attributesOf(source: string, dialect?: Dialect): MxAttr[] {
  const { body } = parseMxDocument(source, "page.mx", undefined, dialect) as {
    body: { attributes: MxAttr[] }[];
  };
  return body[0]?.attributes ?? [];
}

function irOf(source: string, dialect?: Dialect): Ir {
  let ir: Ir | undefined;
  compileSource(source, "page.mx", declarations, {
    targets,
    ...(dialect ? { dialect } : {}),
    emitIr: (lowered) => {
      ir = lowered;
      return "";
    },
  });
  return ir as Ir;
}

type Element = Extract<IrNode, { kind: "Element" }>;

function attr(source: string, name: string, dialect?: Dialect): Attr {
  const [element] = irOf(source, dialect).body.filter(
    (node): node is Element => node.kind === "Element",
  );
  const found = element?.attrs.find(
    (each) => each.kind !== "spread" && each.name === name,
  );
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

function caught(run: () => unknown): TranslateError {
  try {
    run();
  } catch (error) {
    if (!(error instanceof TranslateError)) throw error;
    return error;
  }
  throw new Error("expected an error");
}

describe("a value row claims the whole value", () => {
  it("the claimed node is `MxAttribute.value`, frozen, at the value's span", () => {
    const [to] = attributesOf("sort to=~user.name\n", REF_DIALECT);
    expect(to).toMatchObject({ type: "MxAttribute", name: "to" });
    expect(to?.value).toEqual({
      type: "ref:Ref",
      path: ["user", "name"],
      span: { sourceStart: 8, sourceEnd: 18 },
      start: 8,
      end: 18,
    });
    expect(Object.isFrozen(to?.value)).toBe(true);
  });

  it("the IR attribute is the string the type's `lower` gave, with the node", () => {
    const to = attr("sort to=~user.name\n", "to", REF_DIALECT);
    expect(to).toMatchObject({
      kind: "static",
      value: "user.name",
      valueSpan: { sourceStart: 8, sourceEnd: 18 },
      node: { type: "ref:Ref", path: ["user", "name"] },
    });
  });

  it("a value the `match` does not cover whole is not claimed", () => {
    // `~user + 1` starts on `~`, but the row matches only `~user`.
    const source = "sort to=(~user + 1) at=~user+1\n";
    expect(treeOf(source, REF_DIALECT)).toEqual(treeOf(source));
  });

  it("a bound value (`:=`) and a spread are never claimed", () => {
    for (const source of ["sort to:=~user\n", "sort ...~user\n"]) {
      expect(treeOf(source, REF_DIALECT)).toEqual(treeOf(source));
    }
  });

  it("a tag's default value (`sort=~user`) is claimed: the `value` attribute", () => {
    const [value] = attributesOf("sort=~user\n", REF_DIALECT);
    expect(value).toMatchObject({
      name: null,
      value: { type: "ref:Ref", path: ["user"], start: 5, end: 10 },
    });
    expect(attr("sort=~user\n", "value", REF_DIALECT)).toMatchObject({
      kind: "static",
      value: "user",
      node: { type: "ref:Ref" },
    });
  });

  it("with no value row, the parse asks no node type", () => {
    const source = "sort to=~user\n";
    const none: Dialect = { ...REF_DIALECT, table: {} };
    expect(treeOf(source, none)).toEqual(treeOf(source));
  });
});

describe("a node type declines a value with `undefined`", () => {
  it("the value parses as if no row matched", () => {
    const source = "sort to=~skip\n";
    const declined = treeOf(source, REF_DIALECT);
    expect(declined).toEqual(treeOf(source));
    expect(JSON.stringify(declined)).not.toContain("ref:Ref");
  });

  it("declines one value and claims the next", () => {
    const attributes = attributesOf("sort a=~skip b=~user\n", REF_DIALECT);
    expect(attributes.map((each) => each.value.type)).toEqual([
      "MxExpression",
      "ref:Ref",
    ]);
  });
});

describe("a value row naming core's `mx:String`", () => {
  it.each([
    ['"a\\"b\\n"', 'a"b\n'],
    ["'it\\'s'", "it's"],
    ["hello", "hello"],
  ])("`%s` is the string %j", (text, value) => {
    const source = `div title=${text}\n`;
    const [title] = attributesOf(source, STRINGS);
    expect(title?.value).toEqual({
      type: "mx:String",
      value,
      raw: text,
      span: { sourceStart: 10, sourceEnd: 10 + text.length },
      start: 10,
      end: 10 + text.length,
    });
    expect(attr(source, "title", STRINGS)).toMatchObject({
      kind: "static",
      value,
      node: { type: "mx:String", value, raw: text },
    });
  });

  it("an unquoted value is the word, not the identifier it would be", () => {
    const [plain] = attributesOf("div title=hello\n");
    expect(plain?.value.type).toBe("MxExpression");
  });

  it.each([
    ['"\\x41"', "another escape"],
    ['"\\01"', "an octal escape"],
    ["`h`", "a template literal"],
  ])("declines `%s` (%s): it parses as the expression it is", (text) => {
    const source = `div title=${text}\n`;
    expect(treeOf(source, STRINGS)).toEqual(treeOf(source));
  });
});

describe("a value row naming core's `mx:Expression`", () => {
  it("declines every value: the tree is the one with no row", () => {
    const dialect = valueRow("Expression", "mx");
    for (const source of ["sort to=~user\n", "sort to=~a.b x=~c\n"]) {
      expect(treeOf(source, dialect)).toEqual(treeOf(source));
    }
  });
});

describe("a value row naming a type the value position cannot claim", () => {
  it.each([
    [
      "`mx:Trigger` (line and attribute only)",
      valueRow("Trigger", "mx"),
      'the `dialect` option is not a valid dialect: `dialect.table.valueTriggers[0].node` (trigger "ref") names `mx:Trigger`, which is not a registered node type in value position (a row there can name `mx:String`, `mx:Expression`, `ref:Ref`)',
    ],
    [
      "an unregistered type of the dialect",
      valueRow("Path", "ref"),
      'the `dialect` option is not a valid dialect: `dialect.table.valueTriggers[0].node` (trigger "ref") names `ref:Path`, which is not a registered node type (a row can name `mx:String`, `mx:Expression`, `ref:Ref`)',
    ],
    [
      "a core type with no `parse`",
      valueRow("Tag", "mx"),
      'the `dialect` option is not a valid dialect: `dialect.table.valueTriggers[0].node` (trigger "ref") names `mx:Tag`, which is not a registered node type (a row can name `mx:String`, `mx:Expression`, `ref:Ref`)',
    ],
  ])("%s is not registered", (_, dialect, message) => {
    expect(caught(() => irOf("sort to=~user\n", dialect)).message).toBe(
      message,
    );
  });

  it("`mx:String` in an attribute list is not registered there", () => {
    const dialect: Dialect = {
      ...REF_DIALECT,
      table: {
        attributeTriggers: [
          { ...REF, node: { type: "String", dialect: "mx" } },
        ],
      },
    };
    expect(caught(() => irOf("sort ~user\n", dialect)).message).toBe(
      'the `dialect` option is not a valid dialect: `dialect.table.attributeTriggers[0].node` (trigger "ref") names `mx:String`, which is not a registered node type in attribute position (a row there can name `mx:Trigger`, `mx:Expression`, `ref:Ref`)',
    );
  });

  it("a row armed on a character no value starts with is refused", () => {
    const dialect: Dialect = {
      ...REF_DIALECT,
      table: { valueTriggers: [{ ...REF, chars: "=", match: "=x" }] },
    };
    expect(caught(() => irOf("sort to=~user\n", dialect)).message).toBe(
      'the `dialect` option is not a valid dialect: `dialect.table.valueTriggers[0].chars` (trigger "ref"): valueTriggers may not be armed on "=": it cannot start an attribute value',
    );
  });

  it("a row with no `{ type, dialect }` is refused in `valueTriggers`", () => {
    const dialect: Dialect = {
      ...REF_DIALECT,
      table: { valueTriggers: [{ ...REF, node: { call: "ref" } }] },
    };
    expect(() => irOf("sort to=~user\n", dialect)).toThrow(
      "a value trigger names a registered node type (`{ type, dialect }`): the node is the attribute's value",
    );
  });
});

describe("the contract view's attribute is its name and its value node", () => {
  const sort = {
    attributes: { to: { type: "string" }, s: { type: "string" } },
  } as unknown as CustomTag;

  function attrsOf(source: string): readonly ContractAttr[] {
    let seen: LoweredUnit | undefined;
    const result = lowerSource(source, "page.mx", {
      dialect: {
        ...REF_DIALECT,
        afterLower: (unit) => {
          seen = unit;
        },
      },
      customTags: { sort },
      tagRules: "none",
    });
    expect(result.diagnostics).toEqual([]);
    return seen?.calls[0]?.attrs ?? [];
  }

  it("a claimed value is the node the type parsed, frozen", () => {
    const [to, s] = attrsOf("sort to=~user.name s='x'\n");
    expect(to).toEqual({
      name: "to",
      nameSpan: { sourceStart: 5, sourceEnd: 7 },
      label: "`to`",
      value: {
        type: "ref:Ref",
        path: ["user", "name"],
        span: { sourceStart: 8, sourceEnd: 18 },
        start: 8,
        end: 18,
      },
    });
    expect(Object.isFrozen(to)).toBe(true);
    expect(Object.isFrozen((to as { value: object }).value)).toBe(true);
    // An unclaimed string keeps core's `mx:String` view.
    expect(s).toMatchObject({
      name: "s",
      value: {
        type: "mx:String",
        value: "x",
        span: { sourceStart: 21, sourceEnd: 24 },
      },
    });
  });
});

// Mesh's `MESH_SYNTAX` with a value row: the alpha.15 regression.
const load = createRequire(import.meta.url);
const meshSyntax = (
  load(join(import.meta.dirname, "syntax/mesh.ts")) as { default: Dialect }
).default;
const contracts = (
  load(
    join(import.meta.dirname, "fixtures/syntax/mesh-corpus/contracts.ts"),
  ) as { default: Record<string, CustomTag> }
).default;

interface Atom extends DialectNode {
  readonly name: string;
}

/** Mesh's syntax plus a value row on `:` naming its own `Atom` type. */
const ATOM_VALUES: Dialect = {
  ...meshSyntax,
  id: "mesh",
  table: {
    ...meshSyntax.table,
    valueTriggers: [
      {
        id: "atom-value",
        chars: ":",
        match: "::?[A-Za-z_$][\\w$]*(?:-[\\w$]+)*",
        standIn: "keep",
        node: { type: "Atom", dialect: "mesh" },
      },
    ],
  },
  nodeTypes: {
    Atom: {
      keys: [],
      parse: (text) => ({ name: text.slice(1) }),
      print: (node) => `:${node.name}`,
      lower: (node) => node.name,
    } satisfies NodeType<Atom>,
  },
};

function meshDiagnostics(source: string, dialect: Dialect) {
  return lowerSource(source, "/x/old-relationship.mesh.mx", {
    dialect,
    customTags: contracts,
    tagRules: "none",
    structural: "reject",
    unknownTags: "reject",
    imports: "pass",
  }).diagnostics.map((each) => [each.message, each.line, each.column]);
}

describe("a claimed default value ends at a terminating attribute row", () => {
  // `fixtures/syntax/mesh-corpus/entities/.../negative/old-relationship.mesh.mx`.
  const source =
    "entity :Todo\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to=:List :list\n";

  it("`belongs-to=:List :list` is the default `:List` and the name `:list`", () => {
    expect(meshDiagnostics(source, ATOM_VALUES)).toEqual([
      ["`<belongs-to>`: unknown attribute `value`", 5, 14],
    ]);
  });

  it("with no value row the value runs on, as it does in Mesh's syntax today", () => {
    expect(meshDiagnostics(source, meshSyntax)).toEqual([
      ["Expected a single expression, but found `:` after it.", 5, 21],
    ]);
  });

  it("a value the row declines keeps the expression's end", () => {
    const declining: Dialect = {
      ...ATOM_VALUES,
      nodeTypes: {
        Atom: {
          keys: [],
          parse: () => undefined,
          print: () => "",
          lower: () => "",
        } satisfies NodeType<Atom>,
      },
    };
    expect(meshDiagnostics(source, declining)).toEqual(
      meshDiagnostics(source, meshSyntax),
    );
  });
});
