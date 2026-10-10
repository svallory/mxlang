/**
 * The node-type registry (decision 202 item 3): core's MX AST types as
 * dialect zero (`mx:Tag`, keys only), a dialect's `nodeTypes` keyed
 * `id:Type`, a row naming `node: { type, dialect }` in attribute, line and
 * value position (the row's `match` ends the node, the type's `parse` reads
 * it, its `lower` builds core's shapes), a claimed value's node riding on
 * the IR attribute,
 * `print(parse(text))` giving the text back, and every refusal positioned.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource, parseMxDocument } from "./compile.ts";
import { TranslateError } from "./core.ts";
import {
  type ClaimContext,
  CORE_DIALECT,
  claimNode,
  type DialectNode,
  type NodeType,
  nodeTypeRegistry,
} from "./dialect-registry.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { type Dialect, defaultSyntax, type Trigger } from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup as targets } from "./test-targets.ts";
import { attributesWithTriggers, childrenWithTriggers } from "./triggers.ts";

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

/** `~user.name`: a path into the record the template reads. */
interface Ref extends DialectNode {
  readonly path: readonly string[];
}

const REF: Trigger = {
  id: "ref",
  chars: "~",
  match: "~[a-z]+(?:\\.[a-z]+)*",
  standIn: "identifier",
  node: { type: "Ref", dialect: "ref" },
};

let parses = 0;

const RefType: NodeType<Ref> = {
  keys: [],
  parse(text, _span, ctx) {
    parses++;
    const path = text.slice(1).split(".");
    if (path.includes("bad")) {
      ctx.fail("`bad` is not a field of the record", { code: "ref-bad" });
    }
    return { path };
  },
  print: (node) => `~${node.path.join(".")}`,
  lower(node, ctx) {
    const value = node.path.join(".");
    if (ctx.position === "value") return value;
    if (ctx.position === "line") {
      return ctx.child("ref", [ctx.attribute("to", value)]);
    }
    return ctx.attribute("ref", value);
  },
};

const REF_DIALECT: Dialect = {
  id: "ref",
  name: "Ref",
  table: {
    attributeTriggers: [REF],
    lineTriggers: [REF],
    valueTriggers: [REF],
  },
  nodeTypes: { Ref: RefType },
};

/** REF_DIALECT with `Ref` replaced by `patch` over it. */
const refWith = (patch: Partial<NodeType<Ref>>): Dialect => ({
  ...REF_DIALECT,
  nodeTypes: { Ref: { ...RefType, ...patch } },
});

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-node-types-")));
  parses = 0;
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

type Element = Extract<IrNode, { kind: "Element" }>;

function elements(nodes: readonly IrNode[]): Element[] {
  return nodes.filter((node): node is Element => node.kind === "Element");
}

function attr(node: Element | undefined, name: string): Attr {
  const found = node?.attrs.find(
    (each) => each.kind !== "spread" && each.name === name,
  );
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

describe("the registry", () => {
  it("core is dialect zero: its MX AST types, keyed without the `Mx` prefix, with child keys", () => {
    const core = nodeTypeRegistry();
    expect(CORE_DIALECT).toBe("mx");
    expect(core.get("mx:Tag")).toEqual({
      key: "mx:Tag",
      dialect: "mx",
      type: "Tag",
      keys: [
        "name",
        "typeArgs",
        "var",
        "args",
        "typeParams",
        "params",
        "shorthands",
        "attributes",
        "body",
      ],
    });
    expect(core.get("mx:Text")?.keys).toEqual([]);
    expect(core.get("mx:MxTag")).toBeUndefined();
    // Core lowers its own types directly: none carries a node type.
    expect([...core.values()].some((each) => each.nodeType)).toBe(false);
  });

  it("a dialect's types follow core's, keyed `id:Type`, built once per dialect", () => {
    const registry = nodeTypeRegistry(REF_DIALECT);
    expect(registry.get("ref:Ref")).toMatchObject({
      key: "ref:Ref",
      dialect: "ref",
      type: "Ref",
      // Core appends the containers it places on a claimed node.
      keys: ["value", "args"],
      nodeType: RefType,
    });
    expect(registry.get("mx:Tag")).toBe(nodeTypeRegistry().get("mx:Tag"));
    expect(nodeTypeRegistry(REF_DIALECT)).toBe(registry);
  });

  it("a dialect without node types shares core's registry", () => {
    expect(nodeTypeRegistry({ id: "plain", name: "Plain", table: {} })).toBe(
      nodeTypeRegistry(),
    );
  });
});

describe("a node type in an attribute list", () => {
  it("is what its `lower` built: a string attribute holds no node", () => {
    const source = "sort asc ~user.name\n";
    const [sort] = elements(irOf(source, REF_DIALECT).body);
    const ref = attr(sort, "ref");
    expect(ref).toMatchObject({ kind: "static", value: "user.name" });
    expect(ref).not.toHaveProperty("node");
  });
});

describe("a node type in value position", () => {
  it("is a static attribute carrying the parsed node", () => {
    const source = "sort to=~user.name\n";
    const [sort] = elements(irOf(source, REF_DIALECT).body);
    const ref = attr(sort, "to");
    expect(ref).toMatchObject({
      kind: "static",
      value: "user.name",
      node: {
        type: "ref:Ref",
        path: ["user", "name"],
        span: { sourceStart: 8, sourceEnd: 18 },
      },
    });
    if (ref.kind !== "static" || !ref.node) throw new Error("no node");
    expect(Object.isFrozen(ref.node)).toBe(true);
    expect(ref.valueSpan).toEqual({ sourceStart: 8, sourceEnd: 18 });
  });

  it("`print(parse(text))` is the text the row matched", () => {
    const source = "sort to=~user.name.first\ndiv\n  sort to=~a\n";
    const [sort, div] = elements(irOf(source, REF_DIALECT).body);
    const [ref] = elements((div as Element).children);
    const nodes = [attr(sort, "to"), attr(ref, "to")].map(
      (each) => (each.kind === "static" ? each.node : undefined) as Ref,
    );
    expect(nodes.map((node) => node.path)).toEqual([
      ["user", "name", "first"],
      ["a"],
    ]);
    for (const node of nodes) {
      expect(RefType.print(node)).toBe(
        source.slice(node.span.sourceStart, node.span.sourceEnd),
      );
    }
  });
});

describe("a node type on a tagless line", () => {
  it("is a child the type's `lower` built", () => {
    const [div] = elements(irOf("div\n  ~user.name\n", REF_DIALECT).body);
    const [ref] = elements((div as Element).children);
    expect(ref?.name).toBe("ref");
    expect(attr(ref, "to")).toMatchObject({
      kind: "static",
      value: "user.name",
    });
  });

  it("parses each trigger once", () => {
    irOf("div\n  ~a\nsort ~b\n", REF_DIALECT);
    expect(parses).toBe(2);
  });
});

describe("the lowering cache: each node lowered once, in source order", () => {
  it("each `lower` runs once per node, in source order, across positions", () => {
    const lowered: string[] = [];
    const dialect = refWith({
      lower(node, ctx) {
        lowered.push(`${ctx.position}:${node.path.join(".")}`);
        return RefType.lower(node, ctx);
      },
    });
    irOf("div ~a ~b to=~f\n  ~c\n  sort ~d\n  ~e\n", dialect);
    expect(lowered).toEqual([
      "attribute:a",
      "attribute:b",
      "value:f",
      "line:c",
      "attribute:d",
      "line:e",
    ]);
  });
});

describe("a claimed node's row is the one the parser matched", () => {
  /** Two line rows of one type; `tilde`'s `chars` and `match` need the `u` flag. */
  const twoRows = (chars: string, match: string): Dialect => ({
    ...REF_DIALECT,
    table: {
      lineTriggers: [
        { ...REF, id: "amp", chars: "&", match: "&[a-z]+" },
        { ...REF, id: "tilde", chars, match },
      ],
    },
    nodeTypes: {
      Ref: { ...RefType, parse: (text) => ({ path: [text.slice(1)] }) },
    },
  });

  it.each([
    ["an escaped `chars`", "\\x7E", "~[a-z]+"],
    ["a `\\u{…}` class and a `\\p{…}` match", "\\u{7E}", "~\\p{L}+"],
  ])("%s: the IR trigger names the row", (_, chars, match) => {
    const ir = irOf("~foo\n", twoRows(chars, match));
    const tag = ir.body[0] as { trigger?: { id: string; text: string } };
    expect(tag.trigger).toMatchObject({ id: "tilde", text: "~foo" });
  });

  it("a diagnostic names the row", () => {
    const dialect = twoRows("\\x7E", "~[a-z]+");
    const failing = {
      ...dialect,
      nodeTypes: {
        Ref: {
          ...(dialect.nodeTypes?.Ref as NodeType<Ref>),
          lower: () => 42 as never,
        },
      },
    };
    expect(caught(() => irOf("~foo\n", failing)).message).toMatch(
      /^the `tilde` trigger's `lower` \(node type `ref:Ref`\)/,
    );
  });
});

describe("the lowering cache's readers", () => {
  const node = { type: "ref:Ref", start: 4, end: 8 };
  it("a claimed node the pass never lowered is an internal error", () => {
    expect(() => attributesWithTriggers({ attributes: [node] })).toThrow(
      /^internal: the `ref:Ref` node at 4 was read before the trigger pass lowered it$/,
    );
    expect(() => childrenWithTriggers([node])).toThrow(
      /^internal: the `ref:Ref` node at 4/,
    );
  });
});

describe("a claimed node's value is stripped of TypeScript, as a `{ call }` row's", () => {
  const ROW = {
    id: "ref",
    chars: "~",
    match: "~[a-z]+",
    standIn: "identifier" as const,
  };
  type Placing = {
    position: string;
    value?: unknown;
    attribute: (...args: unknown[]) => unknown;
  };
  const place = (name: string, ctx: Placing) =>
    ctx.attribute(name, ctx.value ?? "x");
  const viaType: Dialect = {
    id: "ref",
    name: "Ref",
    table: {
      attributeTriggers: [{ ...ROW, node: { type: "Name", dialect: "ref" } }],
    },
    nodeTypes: {
      Name: {
        keys: [],
        parse: (text: string) => ({ name: text.slice(1) }),
        print: (node: { name: string }) => `~${node.name}`,
        lower: (node: { name: string }, ctx: unknown) =>
          place(node.name, ctx as Placing),
      } as unknown as NodeType,
    },
  };
  const viaCall: Dialect = {
    id: "ref",
    name: "Ref",
    table: { attributeTriggers: [{ ...ROW, node: { call: "ref" } }] },
    lowerTrigger: ((_id: string, text: string, _span: unknown, ctx: Placing) =>
      place(text.slice(1), ctx)) as unknown as Dialect["lowerTrigger"],
  };
  const codeOf = (source: string, dialect: Dialect) =>
    JSON.stringify(
      (irOf(source, dialect).body[0] as { attrs: Attr[] }).attrs[0],
    );

  it.each([
    ["`as`", "div ~title=(x as string)\n"],
    ["`satisfies`", "div ~title=(y satisfies number)\n"],
    ["a typed parameter", "div ~title=((v: number) => v)\n"],
  ])("%s", (_, source) => {
    const typed = codeOf(source, viaType);
    expect(typed).toBe(codeOf(source, viaCall));
    expect(typed).not.toMatch(/"code":"[^"]*(as string|satisfies)/);
    expect(typed).not.toMatch(/"typeAnnotation":\{/);
  });
});

describe("the type's hooks are checked, positioned at the trigger", () => {
  it("`ctx.fail` is the dialect's error, at the node's text, with its code", () => {
    const error = caught(() => irOf("div\n  ~user.bad\n", REF_DIALECT));
    expect(error.message).toBe("`bad` is not a field of the record");
    expect([error.line, error.column]).toEqual([2, 2]);
    expect((error as { diagnosticCode?: string }).diagnosticCode).toBe(
      "ref-bad",
    );
  });

  it("`ctx.fail` at a span inside the document", () => {
    const dialect = refWith({
      parse: (_text, span, ctx) =>
        ctx.fail("here", {
          at: { sourceStart: span.sourceStart + 1, sourceEnd: span.sourceEnd },
        }),
    });
    const error = caught(() => irOf("sort ~user\n", dialect));
    expect([error.line, error.column]).toEqual([1, 6]);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("boom");
      },
      "the `ref` trigger's `parse` (node type `ref:Ref`) threw: boom",
    ],
    [
      "returns no object",
      () => "user" as never,
      "the `ref` trigger's `parse` (node type `ref:Ref`) must return the node's fields as an object, or `undefined` to decline the text",
    ],
    [
      "returns `type`",
      () => ({ path: [], type: "x" }) as never,
      "the `ref` trigger's `parse` (node type `ref:Ref`) returns the node's own fields: core sets `type`",
    ],
    [
      "returns `span`",
      () => ({ path: [], span: null }) as never,
      "the `ref` trigger's `parse` (node type `ref:Ref`) returns the node's own fields: core sets `span`",
    ],
    [
      "calls `ctx.fail` with no message",
      (_text: string, _span: unknown, ctx: { fail(m: string): never }) =>
        ctx.fail(""),
      "the `ref` trigger's `parse` (node type `ref:Ref`): `ctx.fail` takes a non-empty message",
    ],
  ])("a `parse` that %s", (_, parse, message) => {
    const error = caught(() =>
      irOf("sort ~user\n", refWith({ parse: parse as never })),
    );
    expect(error.message).toBe(message);
    expect([error.line, error.column]).toEqual([1, 5]);
  });

  it("a `lower` that returns the wrong shape names the node type", () => {
    const dialect = refWith({
      lower: (_node, ctx) => ctx.child("ref", []),
    });
    const error = caught(() => irOf("sort ~user\n", dialect));
    expect(error.message).toBe(
      "the `ref` trigger's `lower` (node type `ref:Ref`) must return `ctx.attribute(name, value)` for a trigger in an attribute list",
    );
    expect([error.line, error.column]).toEqual([1, 5]);
  });

  it("a `lower` that throws names the node type", () => {
    const dialect = refWith({
      lower: () => {
        throw new Error("boom");
      },
    });
    expect(caught(() => irOf("sort ~user\n", dialect)).message).toBe(
      "the `ref` trigger's `lower` (node type `ref:Ref`) threw: boom",
    );
  });

  it("a value's `lower` returns a string or an expression", () => {
    const dialect = refWith({
      lower: (node, ctx) => ctx.attribute("ref", node.path.join(".")),
    });
    const error = caught(() => irOf("sort to=~user\n", dialect));
    expect(error.message).toBe(
      "the `ref` trigger's `lower` (node type `ref:Ref`) must return a string or `ctx.expression(node)` for an attribute value",
    );
    expect([error.line, error.column]).toEqual([1, 8]);
  });
});

describe("a dialect's node types are validated", () => {
  it.each([
    [
      "no `id`",
      { name: "Ref", table: {}, nodeTypes: { Ref: RefType } },
      "`dialect.id` is required: the dialect's id, lower-case words joined by `-` (`mesh`)",
    ],
    [
      "the id `mx`",
      { id: "mx", name: "MX", table: {} },
      "`dialect.id` cannot be `mx`: that is MX's own dialect",
    ],
    [
      "an id that is not lower-case words",
      { id: "Ref", name: "Ref", table: {} },
      "`dialect.id` must be a dialect id: lower-case words joined by `-` (`mesh`)",
    ],
    [
      "no `name`",
      { id: "ref", table: {} },
      "`dialect.name` is required: a non-empty string, the name tooling shows the dialect's users",
    ],
    [
      "a blank `name`",
      { id: "ref", name: "  ", table: {} },
      "`dialect.name` is required",
    ],
    [
      "a type name that is not PascalCase",
      { id: "ref", name: "Ref", table: {}, nodeTypes: { ref: RefType } },
      "`dialect.nodeTypes.ref`: a node type name is PascalCase",
    ],
    [
      "a field a node type does not have",
      {
        id: "ref",
        name: "Ref",
        table: {},
        nodeTypes: { Ref: { ...RefType, lowerTrigger: () => {} } },
      },
      "`dialect.nodeTypes.Ref.lowerTrigger` is not a node type field (keys, parse, print, lower)",
    ],
    [
      "no `print`",
      {
        id: "ref",
        name: "Ref",
        table: {},
        nodeTypes: { Ref: { ...RefType, print: undefined } },
      },
      "`dialect.nodeTypes.Ref.print` must be a function",
    ],
    [
      "`keys` naming `span`",
      {
        id: "ref",
        name: "Ref",
        table: {},
        nodeTypes: { Ref: { ...RefType, keys: ["span"] } },
      },
      "`dialect.nodeTypes.Ref.keys` cannot name `span`: core sets it on every node",
    ],
    [
      "a row naming a type the dialect does not register",
      {
        ...REF_DIALECT,
        table: {
          lineTriggers: [{ ...REF, node: { type: "Path", dialect: "ref" } }],
        },
      },
      '`dialect.table.lineTriggers[0].node` (trigger "ref") names `ref:Path`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`)',
    ],
    [
      "a row naming another dialect's type",
      {
        ...REF_DIALECT,
        table: {
          lineTriggers: [{ ...REF, node: { type: "Ref", dialect: "mesh" } }],
        },
      },
      '`dialect.table.lineTriggers[0].node` (trigger "ref") names `mesh:Ref`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`); a row names a type of core (`mx`) or of its own dialect: naming another dialect\'s types is not supported yet',
    ],
    [
      "a row naming core's own type",
      {
        ...REF_DIALECT,
        table: {
          lineTriggers: [{ ...REF, node: { type: "Tag", dialect: "mx" } }],
        },
      },
      '`dialect.table.lineTriggers[0].node` (trigger "ref") names `mx:Tag`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`)',
    ],
    [
      "a row in expression position",
      { ...REF_DIALECT, table: { expressionTriggers: [REF] } },
      "a registered node type (`{ type, dialect }`) is not supported in expression position yet; use { call }",
    ],
  ])("refuses %s, at the file start", (_, dialect, message) => {
    const error = caught(() =>
      irOf("div\n", dialect as Dialect, join(dir, "page.mx")),
    );
    expect(error.message).toContain(message);
    expect([error.file, error.line, error.column]).toEqual([
      join(dir, "page.mx"),
      1,
      0,
    ]);
  });

  it("a bare table naming a node type has no dialect to register it", () => {
    const error = caught(() =>
      irOf("div\n", {
        ...defaultSyntax(),
        lineTriggers: [REF],
      } as unknown as Dialect),
    );
    expect(error.message).toContain(
      '`dialect.lineTriggers[0].node` (trigger "ref") names `ref:Ref`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`); a row names a type of core (`mx`) or of its own dialect: naming another dialect\'s types is not supported yet',
    );
  });
});

describe("a dialect package (`package.json#mx.dialect`, decision 212)", () => {
  /** The fixture dialect as a published package: plain JS, default export. */
  const PACKAGE = `const REF = ${JSON.stringify(REF)};
export default {
  table: { attributeTriggers: [REF], lineTriggers: [REF], valueTriggers: [REF] },
  nodeTypes: {
    Ref: {
      keys: [],
      parse: (text) => ({ path: text.slice(1).split(".") }),
      print: (node) => "~" + node.path.join("."),
      lower(node, ctx) {
        const value = node.path.join(".");
        if (ctx.position === "value") return value;
        return ctx.position === "line"
          ? ctx.child("ref", [ctx.attribute("to", value)])
          : ctx.attribute("ref", value);
      },
    },
  },
};`;

  /** A project depending on `@acme/ref-dialect`, which claims `.ref`. */
  function project(dialectSource: string): string {
    return dialectProject(dir, {
      packageName: "@acme/ref-dialect",
      manifest: { id: "ref", name: "Ref", extensions: [".ref"] },
      module: dialectSource,
    }).packageDir;
  }

  it("lowers its node types in every position", () => {
    project(PACKAGE);
    const page = join(dir, "page.ref");
    const [sort, div] = elements(
      irOf("sort ~user.name at=~top\ndiv\n  ~user\n", undefined, page).body,
    );
    expect(attr(sort, "ref")).toMatchObject({ value: "user.name" });
    expect(attr(sort, "at")).toMatchObject({
      value: "top",
      node: { type: "ref:Ref", path: ["top"] },
    });
    const [ref] = elements((div as Element).children);
    expect(attr(ref, "to")).toMatchObject({ value: "user" });
  });

  it("a row naming a type it does not register is an error in the dialect's module", () => {
    const pkg = project(PACKAGE.replace('"type":"Ref"', '"type":"Path"'));
    const error = caught(() => irOf("div\n", undefined, join(dir, "page.ref")));
    expect(error.file).toBe(join(pkg, "index.mjs"));
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.message).toBe(
      '`table.attributeTriggers[0].node` (trigger "ref") names `ref:Path`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`)',
    );
  });

  it("a malformed node type is an error in the dialect's module", () => {
    const pkg = project(PACKAGE.replace("print: (node)", "printed: (node)"));
    const error = caught(() => irOf("div\n", undefined, join(dir, "page.ref")));
    expect(error.file).toBe(join(pkg, "index.mjs"));
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.message).toBe(
      "`nodeTypes.Ref.printed` is not a node type field (keys, parse, print, lower)",
    );
  });
});

/** The tree `parseMxDocument` builds, as plain data. */
function treeOf(source: string, dialect?: Dialect): unknown {
  const document = parseMxDocument(source, "page.mx", undefined, dialect) as
    | { body: unknown }
    | undefined;
  if (!document) throw new Error("the template did not parse");
  return JSON.parse(JSON.stringify(document.body));
}

/** A `Ref` that declines `~skip...`: the text is left to the no-row parse. */
const DECLINING = refWith({
  parse(text, span, ctx) {
    if (text.startsWith("~skip")) return undefined;
    return RefType.parse(text, span, ctx);
  },
});

describe("a node type declines with `undefined`", () => {
  it.each([
    ["an attribute list", "sort asc ~skip\n"],
    ["a tagless line", "div\n  ~skip\n"],
  ])("in %s, the text parses as if no row matched", (_, source) => {
    const declined = treeOf(source, DECLINING);
    expect(declined).toEqual(treeOf(source));
    expect(JSON.stringify(declined)).not.toContain("ref:Ref");
  });

  it("declines one occurrence and claims the next", () => {
    const source = "sort ~skip ~user\n";
    const { body } = parseMxDocument(
      source,
      "page.mx",
      undefined,
      DECLINING,
    ) as {
      body: { attributes: { type: string; start: number }[] }[];
    };
    expect(body[0]?.attributes.map((each) => [each.type, each.start])).toEqual([
      ["MxAttribute", 5],
      ["ref:Ref", 11],
    ]);
  });
});

describe("a claimed node is in the AST at its position", () => {
  it("in an attribute list, between its siblings, frozen", () => {
    const source = "sort asc ~user.name desc\n";
    const { body } = parseMxDocument(
      source,
      "page.mx",
      undefined,
      REF_DIALECT,
    ) as {
      body: { attributes: Record<string, unknown>[] }[];
    };
    const attributes = body[0]?.attributes ?? [];
    expect(attributes.map((each) => each.type)).toEqual([
      "MxAttribute",
      "ref:Ref",
      "MxAttribute",
    ]);
    const node = attributes[1] as Record<string, unknown>;
    expect(node).toMatchObject({
      type: "ref:Ref",
      start: 9,
      end: 19,
      span: { sourceStart: 9, sourceEnd: 19 },
      path: ["user", "name"],
      operator: null,
      value: null,
      args: null,
    });
    expect(Object.isFrozen(node)).toBe(true);
  });

  it("on a tagless line, as a child of the enclosing body", () => {
    const source = "div\n  ~user.name\n";
    const { body } = parseMxDocument(
      source,
      "page.mx",
      undefined,
      REF_DIALECT,
    ) as {
      body: { body: Record<string, unknown>[] }[];
    };
    const [node] = body[0]?.body ?? [];
    expect(node).toMatchObject({
      type: "ref:Ref",
      start: 6,
      end: 16,
      path: ["user", "name"],
    });
  });

  it("a `ctx.fail` in `parse` stops the parse: it is the file's error over an earlier parse error", () => {
    const error = caught(() => irOf("div a=(1 2)\n  ~user.bad\n", REF_DIALECT));
    expect(error.message).toBe("`bad` is not a field of the record");
    expect([error.line, error.column]).toEqual([2, 2]);
  });

  it("with no dialect row, the parse asks no node type", () => {
    let asked = 0;
    const counting = refWith({
      parse(text, span, ctx) {
        asked++;
        return RefType.parse(text, span, ctx);
      },
    });
    treeOf("sort asc ~user\ndiv\n  ~a\n");
    treeOf("sort asc ~user\ndiv\n  ~a\n", {
      ...counting,
      table: { attributeTriggers: [], lineTriggers: [] },
    });
    expect(asked).toBe(0);
    treeOf("sort asc ~user\ndiv\n  ~a\n", counting);
    expect(asked).toBe(2);
  });
});

describe("lowering dispatches on `node.type`", () => {
  /** `!name`: a second type of the same dialect, lowered by its own `lower`. */
  interface Up extends DialectNode {
    readonly name: string;
  }
  const UpType: NodeType<Up> = {
    keys: [],
    parse: (text) => ({ name: text.slice(1) }),
    print: (node) => `!${node.name}`,
    lower: (node, ctx) =>
      ctx.position === "value" ? node.name : ctx.attribute("up", node.name),
  };
  const UP: Trigger = {
    id: "up",
    chars: "!",
    match: "![a-z]+",
    standIn: "identifier",
    node: { type: "Up", dialect: "ref" },
  };

  it("each node is lowered by the type that parsed it", () => {
    const dialect: Dialect = {
      ...REF_DIALECT,
      table: { attributeTriggers: [REF, UP], valueTriggers: [REF, UP] },
      nodeTypes: { Ref: RefType, Up: UpType },
    };
    const [sort] = elements(
      irOf("sort ~user !top a=~user b=!top\n", dialect).body,
    );
    expect(attr(sort, "ref")).toMatchObject({ value: "user" });
    expect(attr(sort, "up")).toMatchObject({ value: "top" });
    expect(attr(sort, "a")).toMatchObject({ node: { type: "ref:Ref" } });
    expect(attr(sort, "b")).toMatchObject({
      value: "top",
      node: { type: "ref:Up", name: "top" },
    });
  });
});

describe("a row can name core's `mx:Trigger` and `mx:Expression`", () => {
  const named = (type: string): Trigger => ({
    ...REF,
    node: { type, dialect: "mx" },
  });

  it("`mx:Trigger` is a `{ call }` row: the dialect's `lowerTrigger` lowers it", () => {
    const calls: string[] = [];
    const dialect: Dialect = {
      id: "ref",
      name: "Ref",
      table: { attributeTriggers: [named("Trigger")] },
      lowerTrigger: (id, text, _span, ctx) => {
        calls.push(`${id} ${text}`);
        return ctx.attribute("ref", text.slice(1));
      },
    };
    const [sort] = elements(irOf("sort ~user\n", dialect).body);
    expect(calls).toEqual(["ref ~user"]);
    expect(attr(sort, "ref")).toMatchObject({ kind: "static", value: "user" });
    const [node] =
      (
        parseMxDocument("sort ~user\n", "page.mx", undefined, dialect) as {
          body: { attributes: { type: string }[] }[];
        }
      ).body[0]?.attributes ?? [];
    expect(node?.type).toBe("MxTrigger");
  });

  it("`mx:Trigger` with no `lowerTrigger` has no lowering yet", () => {
    const dialect: Dialect = {
      id: "ref",
      name: "Ref",
      table: { attributeTriggers: [named("Trigger")] },
    };
    expect(caught(() => irOf("sort ~user\n", dialect)).message).toBe(
      "`ref` trigger has no lowering yet",
    );
  });

  it("`mx:Expression` declines every text in A's positions", () => {
    const dialect: Dialect = {
      id: "ref",
      name: "Ref",
      table: {
        attributeTriggers: [named("Expression")],
        lineTriggers: [named("Expression")],
      },
    };
    for (const source of ["sort asc ~user\n", "div\n  ~user\n"]) {
      expect(treeOf(source, dialect)).toEqual(treeOf(source));
    }
  });
});

describe("`claimNode` refuses a row naming an unregistered type", () => {
  /** A context whose `fail` throws its message and span. */
  const context = (): ClaimContext => ({
    position: "attribute",
    tag: "sort",
    attribute: null,
    fail(message, options) {
      throw Object.assign(new Error(message), { at: options?.at });
    },
  });

  it.each([
    [
      "an unregistered type of the dialect",
      { type: "Path", dialect: "ref" },
      "the `ref` trigger names `ref:Path`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`)",
    ],
    [
      "a core type with no `parse`",
      { type: "Tag", dialect: "mx" },
      "the `ref` trigger names `mx:Tag`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`)",
    ],
    [
      "another dialect's type",
      { type: "Ref", dialect: "mesh" },
      "the `ref` trigger names `mesh:Ref`, which is not a registered node type (a row can name `mx:Trigger`, `mx:Expression`, `ref:Ref`); a row names a type of core (`mx`) or of its own dialect: naming another dialect's types is not supported yet",
    ],
  ])("%s", (_, node, message) => {
    const row: Trigger = { ...REF, node };
    const span = { sourceStart: 5, sourceEnd: 10 };
    expect(() =>
      claimNode(nodeTypeRegistry(REF_DIALECT), row, "~user", span, context()),
    ).toThrow(message);
  });
});
