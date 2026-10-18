/**
 * A node type declares its `schema` (the fields `parse` returns and the
 * positions the type fills), a printer (`print`) and, for the expression
 * slot, a forward (the fresh `ctx.expression` result `lower` returns).
 * Core refuses a type missing a piece when its dialect loads, checks what
 * `parse` and `lower` produce against the schema with an error at the
 * node's text, and refuses two dialects installed in one project that share
 * a marking character or prefix. Every refusal is one positioned
 * `MX_INVALID_DIALECT_MODULE` error that names the dialect, the node type
 * (or both dialects) and what to write instead (spec §13.9.9).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import { findMarkOverlap } from "./dialect-marks.ts";
import type { Ir } from "./ir.ts";
import { type Dialect, defaultSyntax, type Trigger } from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup as targets } from "./test-targets.ts";

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-node-schema-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function irOf(source: string, dialect?: Dialect, file = "page.mx"): Ir {
  let ir: Ir | undefined;
  compileSource(source, file, declarations, {
    targets,
    ...(dialect ? { dialect } : {}),
    emitIr: (lowered) => {
      ir = lowered;
      return "";
    },
  });
  return ir as Ir;
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

const literal = (value: string) => ({
  type: "StringLiteral",
  value,
  extra: { raw: JSON.stringify(value), rawValue: value },
});

const ROW = (list: "expression" | "value" | "attribute" | "line"): Trigger => ({
  id: `tilde-${list}`,
  chars: "~",
  match: "~[a-z]+",
  standIn: "identifier",
  node: { type: "Atom", dialect: "atom" },
});

/** A valid `Atom` node type (`~name`), over which a test patches one piece. */
const ATOM_TYPE = {
  keys: [],
  schema: { fields: { name: "data" }, slot: ["expression", "value"] },
  parse: (text: string) => ({ name: text.slice(1) }),
  print: (node: { name: string }) => `~${node.name}`,
  lower: (node: { name: string }, ctx: { expression(n: object): unknown }) =>
    ctx.expression(literal(node.name)),
};

const atomDialect = (patch: Record<string, unknown> = {}): Dialect =>
  ({
    id: "atom",
    name: "Atoms",
    table: {
      expressionTriggers: [ROW("expression")],
      valueTriggers: [ROW("value")],
    },
    nodeTypes: { Atom: { ...ATOM_TYPE, ...patch } },
  }) as unknown as Dialect;

const FILE = () => join(dir, "page.mx");

describe("a node type must declare its pieces", () => {
  it("a valid type compiles in expression and value position", () => {
    const ir = irOf("div x=(1 + ~a) y=~b\n", atomDialect(), FILE());
    expect(ir.body).toHaveLength(1);
  });

  it.each([
    [
      "no `schema`",
      { schema: undefined },
      'dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema` is required. Declare `schema: { fields: { name: "data" }, slot: ["expression","value"] }`',
    ],
    [
      "a `schema` that is not an object",
      { schema: "expression" },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema` must be an object (`{ fields, slot }`)",
    ],
    [
      "a `schema` with another field",
      { schema: { fields: {}, slot: ["value"], holes: [] } },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema.holes` is not a schema field (fields, slot)",
    ],
    [
      "no `schema.fields`",
      { schema: { slot: ["value"] } },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema.fields` is required",
    ],
    [
      "a field of an unknown kind",
      { schema: { fields: { name: "text" }, slot: ["value"] } },
      'dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema.fields.name` must be "node", "expression" or "data"',
    ],
    [
      "a field named `span`",
      { schema: { fields: { span: "data" }, slot: ["value"] } },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema.fields` cannot name `span`: core sets it on every node",
    ],
    [
      "a key that is not a node field",
      { keys: ["name"] },
      'dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.keys` names `name`, so `dialect.nodeTypes.Atom.schema.fields.name` must be "node" (it is "data")',
    ],
    [
      "a node field that is not a key",
      { schema: { fields: { child: "node" }, slot: ["value"] } },
      'dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema.fields.child` is "node", so `dialect.nodeTypes.Atom.keys` must list `child`',
    ],
    [
      "an empty `slot`",
      { schema: { fields: {}, slot: [] } },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema.slot` must be a non-empty list of the positions the type fills",
    ],
    [
      "a `slot` naming a position that does not exist",
      { schema: { fields: {}, slot: ["body"] } },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema.slot` must be a non-empty list of the positions the type fills",
    ],
    [
      "a `slot` naming a position twice",
      { schema: { fields: {}, slot: ["value", "value"] } },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.schema.slot` must be a non-empty list of the positions the type fills",
    ],
    [
      "no printer",
      { print: undefined },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.print` must be a function (the printer",
    ],
    [
      "no `lower` (the forward)",
      { lower: undefined },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.lower` must be a function (it returns",
    ],
    [
      "no `parse`",
      { parse: undefined },
      "dialect `atom`, node type `Atom`: `dialect.nodeTypes.Atom.parse` must be a function",
    ],
  ])(
    "%s is one positioned error at the dialect option",
    (_, patch, message) => {
      const error = caught(() => irOf("div\n", atomDialect(patch), FILE()));
      expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
      expect(error.message).toContain(message);
      expect([error.file, error.line, error.column]).toEqual([FILE(), 1, 0]);
    },
  );

  it("a missing `schema` suggests the slot of the rows that name the type", () => {
    const dialect = atomDialect({ schema: undefined });
    const error = caught(() => irOf("div\n", dialect, FILE()));
    expect(error.message).toContain(
      'Declare `schema: { fields: { name: "data" }, slot: ["expression","value"] }`',
    );
    const valueOnly = {
      ...dialect,
      table: { valueTriggers: [ROW("value")] },
    } as Dialect;
    expect(caught(() => irOf("div\n", valueOnly, FILE())).message).toContain(
      'slot: ["value"] }`',
    );
  });

  it("a row naming the type at a position outside its `slot` says which slot it declares", () => {
    const dialect = atomDialect({
      schema: { fields: { name: "data" }, slot: ["value"] },
    });
    const error = caught(() => irOf("div x=(~a)\n", dialect, FILE()));
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toContain(
      '`dialect.table.expressionTriggers[0].node` (trigger "tilde-expression") names `atom:Atom` in expression position, but dialect `atom`\'s node type `Atom` declares `schema.slot` ["value"]. Add "expression" to its `schema.slot`, or move the row to a position the slot lists (value)',
    );
    expect([error.file, error.line, error.column]).toEqual([FILE(), 1, 0]);
  });

  it("a plain-JS dialect package is refused in its module at 1:0", () => {
    const pkg = dialectProject(dir, {
      packageName: "@acme/atoms",
      manifest: { id: "atom", name: "Atoms", extensions: [".atm"] },
      module: `export default { table: { expressionTriggers: [${JSON.stringify(ROW("expression"))}] }, nodeTypes: { Atom: { keys: [], parse: (t) => ({ name: t.slice(1) }), print: (n) => "~" + n.name, lower: (n, ctx) => ctx.expression({ type: "StringLiteral", value: n.name }) } } };`,
    });
    const error = caught(() =>
      irOf("div x=(~a)\n", undefined, join(dir, "page.atm")),
    );
    expect(error.file).toBe(join(pkg.packageDir, "index.mjs"));
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toContain(
      "dialect `atom`, node type `Atom`: `nodeTypes.Atom.schema` is required",
    );
  });
});

describe("core checks what a node type produces against its schema", () => {
  const SOURCE = "div x=(1 + ~a)\n";
  const at = (error: TranslateError) => [error.line, error.column];

  it("`parse` returning a field the schema does not declare is an error at the node", () => {
    const dialect = atomDialect({
      parse: (text: string) => ({ name: text.slice(1), extra: 1 }),
    });
    const error = caught(() => irOf(SOURCE, dialect, FILE()));
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toBe(
      'dialect `atom`, node type `Atom`: `parse` returned `extra`, which `schema.fields` does not declare. Add it to `schema.fields` (as "node", "expression" or "data"), or stop returning it',
    );
    expect(at(error)).toEqual([1, 11]);
  });

  it("an `expression` field that does not hold a parsed expression is an error at the node", () => {
    const dialect = atomDialect({
      schema: {
        fields: { name: "expression" },
        slot: ["expression", "value"],
      },
    });
    const error = caught(() => irOf(SOURCE, dialect, FILE()));
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toBe(
      'dialect `atom`, node type `Atom`: `parse` returned a `name` that is not a parsed host expression (a node with a `type`) or `null`, and `schema.fields.name` is "expression". Return a parsed host expression (a node with a `type`) or `null`, or declare the field "data"',
    );
    expect(at(error)).toEqual([1, 11]);
  });

  it("a node placed with `ctx.attribute` in a position outside the `slot` is an error at its span", () => {
    const dialect = {
      id: "atom",
      name: "Atoms",
      table: {
        attributeTriggers: [
          { ...ROW("attribute"), node: { call: "place" } } as Trigger,
        ],
      },
      lowerTrigger: (
        _id: string,
        text: string,
        span: unknown,
        ctx: { attribute(n: string, v: unknown): unknown },
      ) =>
        ctx.attribute("name", { type: "atom:Atom", name: text.slice(1), span }),
      nodeTypes: {
        Atom: {
          ...ATOM_TYPE,
          schema: { fields: { name: "data" }, slot: ["expression"] },
        },
      },
    } as unknown as Dialect;
    const error = caught(() => irOf("div ~a\n", dialect, FILE()));
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toBe(
      'dialect `atom`, node type `Atom`: a node of this type was lowered in an attribute value, but its `schema.slot` is ["expression"]. Add "value" to `schema.slot`, or write the node where the type is declared to go',
    );
    expect(at(error)).toEqual([1, 4]);
  });

  it("a node placed with a field the schema does not declare is an error at its span", () => {
    const dialect = {
      id: "atom",
      name: "Atoms",
      table: {
        attributeTriggers: [
          { ...ROW("attribute"), node: { call: "place" } } as Trigger,
        ],
      },
      lowerTrigger: (
        _id: string,
        text: string,
        span: unknown,
        ctx: { attribute(n: string, v: unknown): unknown },
      ) =>
        ctx.attribute("name", {
          type: "atom:Atom",
          name: text.slice(1),
          colour: "red",
          span,
        }),
      nodeTypes: { Atom: ATOM_TYPE },
    } as unknown as Dialect;
    const error = caught(() => irOf("div ~a\n", dialect, FILE()));
    expect(error.message).toBe(
      'dialect `atom`, node type `Atom`: the node has `colour`, which `schema.fields` does not declare. Add it to `schema.fields` (as "node", "expression" or "data"), or leave it off the node',
    );
    expect(at(error)).toEqual([1, 4]);
  });

  it("a placed node whose `expression` field is not an expression is an error at its span", () => {
    const dialect = {
      id: "atom",
      name: "Atoms",
      table: {
        attributeTriggers: [
          { ...ROW("attribute"), node: { call: "place" } } as Trigger,
        ],
      },
      lowerTrigger: (
        _id: string,
        text: string,
        span: unknown,
        ctx: { attribute(n: string, v: unknown): unknown },
      ) =>
        ctx.attribute("name", {
          type: "atom:Atom",
          name: text.slice(1),
          span,
        }),
      nodeTypes: {
        Atom: {
          ...ATOM_TYPE,
          schema: { fields: { name: "expression" }, slot: ["value"] },
        },
      },
    } as unknown as Dialect;
    const error = caught(() => irOf("div ~a\n", dialect, FILE()));
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toBe(
      'dialect `atom`, node type `Atom`: the node\'s `name` is not a parsed host expression (a node with a `type`) or `null`, and `schema.fields.name` is "expression". Give it a parsed host expression (a node with a `type`) or `null`, or declare the field "data"',
    );
    expect(at(error)).toEqual([1, 4]);
  });

  it("an `expression` field holding a parsed expression, and a `null` one, pass", () => {
    const dialect = atomDialect({
      schema: {
        fields: { hole: "expression", empty: "expression", name: "data" },
        slot: ["expression", "value"],
      },
      parse: (text: string) => ({
        name: text.slice(1),
        hole: { type: "Identifier", name: "x" },
        empty: null,
      }),
    });
    expect(irOf(SOURCE, dialect, FILE()).body).toHaveLength(1);
  });

  it("a forward shared by two nodes is an error at the second node", () => {
    const shared = literal("same");
    const dialect = atomDialect({
      lower: (_node: unknown, ctx: { expression(n: object): unknown }) =>
        ctx.expression(shared),
    });
    const error = caught(() => irOf("div x=(~a + ~b)\n", dialect, FILE()));
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toBe(
      "dialect `atom`, node type `Atom`: `lower` returned a forward that another node already stands for. Build a new object on every call (a literal kept in a variable and returned twice is shared), so each node has its own forward",
    );
    expect(at(error)).toEqual([1, 12]);
  });

  it("a fresh forward per node compiles, and each node is listed", () => {
    const ir = irOf("div x=(~a + ~b)\n", atomDialect(), FILE());
    expect(ir.body).toHaveLength(1);
  });
});

/** A dialect package marking `chars` / `match` (an expression row), for a project. */
function markPackage(
  id: string,
  extension: string,
  chars: string,
  match: string,
): void {
  const row: Trigger = {
    id: `${id}-row`,
    chars,
    match,
    standIn: "identifier",
    node: { type: "M", dialect: id },
  };
  dialectProject(dir, {
    packageName: `@acme/${id}`,
    manifest: { id, name: id.toUpperCase(), extensions: [extension] },
    module: `export default { table: { expressionTriggers: [${JSON.stringify(row)}] }, nodeTypes: { M: { keys: [], schema: { fields: { name: "data" }, slot: ["expression"] }, parse: (t) => ({ name: t.slice(1) }), print: (n) => ${JSON.stringify(chars[0])} + n.name, lower: (n, ctx) => ctx.expression({ type: "StringLiteral", value: n.name, extra: { raw: '"x"', rawValue: n.name } }) } } };`,
  });
}

describe("the dialects installed in one project have disjoint marks", () => {
  const SHARED =
    "dialects `a` (A) and `b` (B) are installed in one project and both mark";

  it("two dialects marking the same character are an error naming both", () => {
    markPackage("a", ".aaa", "~", "~[a-z]+");
    markPackage("b", ".bbb", "~", "~[0-9]+");
    const error = caught(() =>
      irOf("div x=(~a)\n", undefined, join(dir, "page.aaa")),
    );
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toBe(
      `${SHARED} "~": the \`a-row\` row of \`a\` (\`table.expressionTriggers\`) and the \`b-row\` row of \`b\` (\`table.expressionTriggers\`). A mark belongs to one dialect: change \`chars\` and \`match\` of one of those rows to a character or prefix the other does not use, or remove one of the two dependencies`,
    );
    expect(error.file).toMatch(/node_modules\/@acme\/a\/index\.mjs$/);
    expect([error.line, error.column]).toEqual([1, 0]);
  });

  it("the other dialect reports the clash too, naming both", () => {
    markPackage("a", ".aaa", "~", "~[a-z]+");
    markPackage("b", ".bbb", "~", "~[0-9]+");
    const error = caught(() =>
      irOf("div x=(~1)\n", undefined, join(dir, "page.bbb")),
    );
    expect(error.message).toContain(
      "dialects `b` (B) and `a` (A) are installed in one project and both mark",
    );
    expect(error.file).toMatch(/node_modules\/@acme\/b\/index\.mjs$/);
  });

  it("a prefix overlap counts: `%` against `%.`", () => {
    markPackage("a", ".aaa", "%", "%\\.[a-z]+");
    markPackage("b", ".bbb", "%", "%[a-z]+");
    const error = caught(() =>
      irOf("div x=(%.a)\n", undefined, join(dir, "page.aaa")),
    );
    expect(error.message).toContain(`${SHARED} "%"`);
  });

  it("a longer prefix against a shorter one is an overlap", () => {
    markPackage("a", ".aaa", "%", "%\\.[a-z]+");
    markPackage("b", ".bbb", "%", "%\\.x[a-z]+");
    const error = caught(() =>
      irOf("div x=(%.a)\n", undefined, join(dir, "page.aaa")),
    );
    expect(error.message).toContain(`${SHARED} "%."`);
  });

  it("disjoint marks load", () => {
    markPackage("a", ".aaa", "~", "~[a-z]+");
    markPackage("b", ".bbb", "!", "![a-z]+");
    const ir = irOf("div x=(~a)\n", undefined, join(dir, "page.aaa"));
    expect(ir.body).toHaveLength(1);
    const other = irOf("div x=(!a)\n", undefined, join(dir, "page.bbb"));
    expect(other.body).toHaveLength(1);
  });

  it("prefixes that differ after the shared character are disjoint", () => {
    markPackage("a", ".aaa", "%", "%\\.[a-z]+");
    markPackage("b", ".bbb", "%", "%:[a-z]+");
    const ir = irOf("div x=(%.a)\n", undefined, join(dir, "page.aaa"));
    expect(ir.body).toHaveLength(1);
  });

  it("a project with one dialect has nothing to compare", () => {
    markPackage("a", ".aaa", "~", "~[a-z]+");
    const ir = irOf("div x=(~a)\n", undefined, join(dir, "page.aaa"));
    expect(ir.body).toHaveLength(1);
  });
});

describe("a `dialect` option is checked against its project's installed dialects", () => {
  const CLASH =
    "the `dialect` option `atom` (Atoms) and the installed dialect `b` (B) both mark";
  const optionError = (dialect: Dialect, file = FILE()) =>
    caught(() => irOf("div x=(~a)\n", dialect, file));

  it("a clash with an installed dialect is an error naming both, at the file", () => {
    markPackage("b", ".bbb", "~", "~[0-9]+");
    const error = optionError(atomDialect());
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toBe(
      `${CLASH} "~": the \`tilde-expression\` row of \`atom\` (\`table.expressionTriggers\`) and the \`b-row\` row of \`b\` (\`table.expressionTriggers\`). A mark belongs to one dialect: change \`chars\` and \`match\` of one of those rows to a character or prefix the other does not use, or remove the dependency on \`b\``,
    );
    expect(error.file).toBe(FILE());
    expect([error.line, error.column]).toEqual([1, 0]);
  });

  it("a prefix clash counts on the option path too", () => {
    markPackage("b", ".bbb", "~", "~\\.[a-z]+");
    const error = optionError(atomDialect());
    expect(error.message).toContain(`${CLASH} "~"`);
  });

  it("a bare table is checked as well", () => {
    markPackage("b", ".bbb", "~", "~[0-9]+");
    const error = caught(() =>
      irOf(
        "div x=(~a)\n",
        {
          ...defaultSyntax(),
          expressionTriggers: [
            {
              id: "tilde",
              chars: "~",
              match: "~[a-z]+",
              standIn: "identifier",
              node: "identifier",
            },
          ],
        } as unknown as Dialect,
        FILE(),
      ),
    );
    expect(error.message).toContain(
      'the `dialect` option\'s table and the installed dialect `b` (B) both mark "~"',
    );
    expect([error.line, error.column]).toEqual([1, 0]);
  });

  it("a bare table equal to an installed dialect's table is that dialect", () => {
    const row = {
      id: "tilde",
      chars: "~",
      match: "~[a-z]+",
      standIn: "identifier",
      node: "identifier",
    };
    dialectProject(dir, {
      packageName: "@acme/b",
      manifest: { id: "b", name: "B", extensions: [".bbb"] },
      module: `export default { table: { expressionTriggers: [${JSON.stringify(row)}] } };`,
    });
    const table = {
      ...defaultSyntax(),
      expressionTriggers: [row],
    } as unknown as Dialect;
    expect(irOf("div x=(~a)\n", table, FILE()).body).toHaveLength(1);
  });

  it("disjoint marks pass", () => {
    markPackage("b", ".bbb", "!", "![a-z]+");
    expect(irOf("div x=(~a)\n", atomDialect(), FILE()).body).toHaveLength(1);
  });

  it("the installed copy of the passed dialect is not a clash", () => {
    markPackage("atom", ".aaa", "~", "~[a-z]+");
    expect(irOf("div x=(~a)\n", atomDialect(), FILE()).body).toHaveLength(1);
  });

  it("a peer whose module does not load is skipped", () => {
    markPackage("b", ".bbb", "~", "~[0-9]+");
    dialectProject(dir, {
      packageName: "@acme/b",
      manifest: { id: "b", name: "B", extensions: [".bbb"] },
      module: "throw new Error('broken');",
    });
    expect(irOf("div x=(~a)\n", atomDialect(), FILE()).body).toHaveLength(1);
  });

  it("no project: a file with no package.json, or a virtual name, is not compared", () => {
    expect(irOf("div x=(~a)\n", atomDialect(), FILE()).body).toHaveLength(1);
    markPackage("b", ".bbb", "~", "~[0-9]+");
    // A relative name is not resolved against the working directory.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(irOf("div x=(~a)\n", atomDialect(), "page.mx").body).toHaveLength(
        1,
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it("a clash with core's own marks is refused before any project is read", () => {
    const opener = {
      ...atomDialect(),
      table: {
        attributeTriggers: [
          { ...ROW("attribute"), chars: "<", match: "<[a-z]+" },
        ],
      },
    } as unknown as Dialect;
    const error = caught(() => irOf("div x=(1)\n", opener, FILE()));
    expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
    expect(error.message).toContain("is not a valid dialect");
    expect(error.message).toContain("attributeTriggers[0]");
    expect([error.line, error.column]).toEqual([1, 0]);
  });

  it("a frozen dialect is compared again when the project gains a dialect", () => {
    markPackage("b", ".bbb", "!", "![a-z]+");
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object") {
        for (const field of Object.values(value)) deepFreeze(field);
        Object.freeze(value);
      }
      return value;
    };
    const frozen = deepFreeze(atomDialect());
    expect(irOf("div x=(~a)\n", frozen, FILE()).body).toHaveLength(1);
    expect(irOf("div x=(~a)\n", frozen, FILE()).body).toHaveLength(1);
    markPackage("c", ".ccc", "~", "~[0-9]+");
    expect(optionError(frozen).message).toContain(
      "the `dialect` option `atom` (Atoms) and the installed dialect `c` (C) both mark",
    );
  });
});

describe("a row cannot mark text core reads itself", () => {
  const rowAt = (chars: string, match: string) =>
    ({ ...ROW("attribute"), chars, match }) as Trigger;
  const optionOf = (row: Trigger): Dialect =>
    ({
      ...atomDialect(),
      table: { attributeTriggers: [row] },
    }) as unknown as Dialect;

  it.each([
    ["a spread", ".", "\\.\\.\\.[a-z]+", '"..."', "a spread (`...`)"],
    [
      "the parameters of a tag",
      "|",
      "\\|[a-z]+",
      '"|"',
      "a tag's parameters (`|`)",
    ],
    ["a prefix of a spread", ".", "\\.\\.[a-z]+", '".."', "a spread (`...`)"],
  ])(
    "%s as a row's mark is refused for the `dialect` option",
    (_, chars, match, mark, what) => {
      const error = caught(() =>
        irOf("div x=(1)\n", optionOf(rowAt(chars, match)), FILE()),
      );
      expect(error.diagnosticCode).toBe("MX_INVALID_DIALECT_MODULE");
      expect(error.message).toBe(
        `the \`dialect\` option is not a valid dialect: \`dialect.table.attributeTriggers[0]\` (row \`tilde-attribute\`) marks ${mark}, which core reads itself in that position as ${what}; core's reading wins, so the row would never fire. Change \`chars\` and \`match\` of the row to start with another character`,
      );
      expect(error.file).toBe(FILE());
      expect([error.line, error.column]).toEqual([1, 0]);
    },
  );

  it("a bare table is refused the same way", () => {
    const row = { ...rowAt("|", "\\|[a-z]+"), node: "attribute" };
    const error = caught(() =>
      irOf(
        "div x=(1)\n",
        { ...defaultSyntax(), attributeTriggers: [row] } as unknown as Dialect,
        FILE(),
      ),
    );
    expect(error.message).toBe(
      "the `dialect` option is not a valid syntax table: `dialect.attributeTriggers[0]` (row `tilde-attribute`) marks \"|\", which core reads itself in that position as a tag's parameters (`|`); core's reading wins, so the row would never fire. Change `chars` and `match` of the row to start with another character",
    );
    expect([error.line, error.column]).toEqual([1, 0]);
  });

  it("the routed path refuses it in the dialect's module", () => {
    dialectProject(dir, {
      packageName: "@acme/p",
      manifest: { id: "p", name: "P", extensions: [".ppp"] },
      module: `export default { table: { attributeTriggers: [{ id: "bar", chars: "|", match: "\\\\|[a-z]+", standIn: "keep", node: { call: "bar" } }] }, lowerTrigger() {} };`,
    });
    const error = caught(() => irOf("div\n", undefined, join(dir, "page.ppp")));
    expect(error.message).toContain(
      '`table.attributeTriggers[0]` (row `bar`) marks "|", which core reads itself in that position as a tag\'s parameters',
    );
    expect(error.file).toMatch(/node_modules\/@acme\/p\/index\.mjs$/);
    expect([error.line, error.column]).toEqual([1, 0]);
  });

  it("other marks in that position are not refused: `:` and `&`", () => {
    for (const [chars, match] of [
      [":", ":[a-z]+"],
      ["&", "&[a-z]+"],
    ]) {
      const row = rowAt(chars as string, match as string);
      const error = caught(() => irOf("div x=(1)\n", optionOf(row), FILE()));
      // Past the table check: the row names a type outside its slot.
      expect(error.message).not.toContain("core reads itself");
    }
  });
});

describe("findMarkOverlap", () => {
  const row = (chars: string, match: string): Trigger => ({
    id: "r",
    chars,
    match,
    standIn: "identifier",
    node: "identifier",
  });
  const table = (...rows: Trigger[]) => ({ expressionTriggers: rows });

  it.each([
    ["the same character", row("~", "~[a-z]"), row("~", "~[0-9]"), "~"],
    [
      "a class sharing one character",
      row("~!", "[~!]a"),
      row("!?", "[!?]"),
      "!",
    ],
    ["a range covering a character", row("a-z", "[a-z]"), row("m", "m"), "m"],
    ["a prefix of another", row("%", "%"), row("%", "%\\.a"), "%"],
    ["a longer prefix first", row("%", "%\\.a"), row("%", "%"), "%"],
    ["a prefix against a class", row("%", "%\\.a"), row("%-&", "[%-&]"), "%"],
  ])("%s overlaps", (_, a, b, mark) => {
    expect(findMarkOverlap(table(a), table(b))?.mark).toBe(mark);
  });

  it.each([
    ["different characters", row("~", "~a"), row("!", "!a")],
    ["prefixes that differ", row("%", "%\\.a"), row("%", "%:a")],
    [
      "a prefix against a class without its first character",
      row("%", "%\\.a"),
      row("a-c", "[a-c]"),
    ],
  ])("%s are disjoint", (_, a, b) => {
    expect(findMarkOverlap(table(a), table(b))).toBeUndefined();
  });

  it("an optional character after the mark is not part of it", () => {
    // `%` then maybe `.`: the mark is `%`, so it clashes with a bare `%`.
    expect(
      findMarkOverlap(table(row("%", "%\\.?a")), table(row("%", "%b")))?.mark,
    ).toBe("%");
  });

  it("top-level alternatives mark their shared prefix: Mesh's atom row against `:a`", () => {
    expect(
      findMarkOverlap(
        table(row(":", "::(?:[a-z]+)?|:[a-z]+")),
        table(row(":", ":a[a-z]*")),
      )?.mark,
    ).toBe(":");
    expect(
      findMarkOverlap(table(row("ac", "ab|cd")), table(row("c", "c[0-9]")))
        ?.mark,
    ).toBe("c");
  });

  it("a `|` inside a group or a class is no alternative", () => {
    expect(
      findMarkOverlap(table(row("~", "~(?:a|b)")), table(row("~", "~c")))?.mark,
    ).toBe("~");
    expect(
      findMarkOverlap(table(row("%", "%[|]a")), table(row("%", "%:a")))?.mark,
    ).toBe("%");
  });

  it("tables with no rows never clash", () => {
    expect(findMarkOverlap({}, table(row("~", "~a")))).toBeUndefined();
    expect(findMarkOverlap(undefined, undefined)).toBeUndefined();
  });
});
