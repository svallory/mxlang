/**
 * The node-type registry (decision 202 item 3): core's MX AST types as
 * dialect zero (`mx:Tag`, keys only), a dialect's `nodeTypes` keyed
 * `id:Type`, a row naming `node: { type, dialect }` in attribute and line
 * position (the row's `match` ends the node, the type's `parse` reads it,
 * its `lower` builds core's shapes), the node riding on the IR attribute,
 * `print(parse(text))` giving the text back, and every refusal positioned.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import {
  CORE_DIALECT,
  type DialectNode,
  type NodeType,
  nodeTypeRegistry,
} from "./dialect-registry.ts";
import type { Attr, Ir, IrNode } from "./ir.ts";
import { type Dialect, defaultSyntax, type Trigger } from "./syntax-table.ts";
import { dialectProject } from "./test-dialect-project.ts";
import { lookup as targets } from "./test-targets.ts";

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
  parse(text, _span, kit) {
    parses++;
    const path = text.slice(1).split(".");
    if (path.includes("bad")) {
      kit.fail("`bad` is not a field of the record", { code: "ref-bad" });
    }
    return { path };
  },
  print: (node) => `~${node.path.join(".")}`,
  lower(node, ctx) {
    const value = node.path.join(".");
    if (ctx.position === "line") {
      return ctx.child("ref", [
        ctx.attribute("to", { kind: "node", node, value }),
      ]);
    }
    return ctx.attribute("ref", { kind: "node", node, value });
  },
};

const REF_DIALECT: Dialect = {
  id: "ref",
  name: "Ref",
  table: { attributeTriggers: [REF], lineTriggers: [REF] },
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
      keys: [],
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
  it("is a static attribute carrying the parsed node", () => {
    const source = "sort asc ~user.name\n";
    const [sort] = elements(irOf(source, REF_DIALECT).body);
    const ref = attr(sort, "ref");
    expect(ref).toMatchObject({
      kind: "static",
      value: "user.name",
      node: {
        type: "ref:Ref",
        path: ["user", "name"],
        span: { sourceStart: 9, sourceEnd: 19 },
      },
    });
    if (ref.kind !== "static" || !ref.node) throw new Error("no node");
    expect(Object.isFrozen(ref.node)).toBe(true);
    expect(ref.valueSpan).toEqual({ sourceStart: 9, sourceEnd: 19 });
  });

  it("`print(parse(text))` is the text the row matched", () => {
    const source = "sort ~user.name.first\ndiv\n  ~a\n";
    const [sort, div] = elements(irOf(source, REF_DIALECT).body);
    const [ref] = elements((div as Element).children);
    const nodes = [attr(sort, "ref"), attr(ref, "to")].map(
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
  it("is a child the type's `lower` built, its attribute carrying the node", () => {
    const [div] = elements(irOf("div\n  ~user.name\n", REF_DIALECT).body);
    const [ref] = elements((div as Element).children);
    expect(ref?.name).toBe("ref");
    expect(attr(ref, "to")).toMatchObject({
      kind: "static",
      value: "user.name",
      node: {
        type: "ref:Ref",
        path: ["user", "name"],
        span: { sourceStart: 6, sourceEnd: 16 },
      },
    });
  });

  it("parses each trigger once", () => {
    irOf("div\n  ~a\nsort ~b\n", REF_DIALECT);
    expect(parses).toBe(2);
  });
});

describe("the type's hooks are checked, positioned at the trigger", () => {
  it("`kit.fail` is the dialect's error, at the node's text, with its code", () => {
    const error = caught(() => irOf("div\n  ~user.bad\n", REF_DIALECT));
    expect(error.message).toBe("`bad` is not a field of the record");
    expect([error.line, error.column]).toEqual([2, 2]);
    expect((error as { diagnosticCode?: string }).diagnosticCode).toBe(
      "ref-bad",
    );
  });

  it("`kit.fail` at a span inside the document", () => {
    const dialect = refWith({
      parse: (_text, span, kit) =>
        kit.fail("here", {
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
      "the `ref` trigger's `parse` (node type `ref:Ref`) must return the node's fields as an object",
    ],
    [
      "returns `type`",
      () => ({ path: [], type: "x" }) as never,
      "the `ref` trigger's `parse` (node type `ref:Ref`) returns the node's own fields: core sets `type` and `span`",
    ],
    [
      "returns `span`",
      () => ({ path: [], span: null }) as never,
      "the `ref` trigger's `parse` (node type `ref:Ref`) returns the node's own fields: core sets `type` and `span`",
    ],
    [
      "calls `kit.fail` with no message",
      (_text: string, _span: unknown, kit: { fail(m: string): never }) =>
        kit.fail(""),
      "the `ref` trigger's `parse` (node type `ref:Ref`): `kit.fail` takes a non-empty message",
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

  it("a node no `parse` returned is refused as an attribute value", () => {
    const dialect = refWith({
      lower: (node, ctx) =>
        ctx.attribute("ref", {
          kind: "node",
          node: { ...node },
          value: "user",
        }),
    });
    expect(caught(() => irOf("sort ~user\n", dialect)).message).toMatch(
      /^the `ref` trigger's `lower` \(node type `ref:Ref`\): an attribute value is .*`\{ kind: "node", node, value \}` with a node a node type parsed$/,
    );
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
      '`dialect.table.lineTriggers[0].node` (trigger "ref") names `ref:Path`, which the dialect does not register (it registers Ref)',
    ],
    [
      "a row naming another dialect's type",
      {
        ...REF_DIALECT,
        table: {
          lineTriggers: [{ ...REF, node: { type: "Ref", dialect: "mesh" } }],
        },
      },
      '`dialect.table.lineTriggers[0].node` (trigger "ref") names the dialect `mesh`, and this dialect is `ref`: a row names a node type of its own dialect',
    ],
    [
      "a row naming core's own type",
      {
        ...REF_DIALECT,
        table: {
          lineTriggers: [{ ...REF, node: { type: "Tag", dialect: "mx" } }],
        },
      },
      '`dialect.table.lineTriggers[0].node` (trigger "ref") names `mx:Tag`: core\'s own node types are not trigger targets',
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
      '`dialect.lineTriggers[0].node` (trigger "ref") names `ref:Ref`, and no dialect registers node types here',
    );
  });
});

describe("a dialect package (`package.json#mx.dialect`, decision 212)", () => {
  /** The fixture dialect as a published package: plain JS, default export. */
  const PACKAGE = `const REF = ${JSON.stringify(REF)};
export default {
  table: { attributeTriggers: [REF], lineTriggers: [REF] },
  nodeTypes: {
    Ref: {
      keys: [],
      parse: (text) => ({ path: text.slice(1).split(".") }),
      print: (node) => "~" + node.path.join("."),
      lower(node, ctx) {
        const value = node.path.join(".");
        return ctx.position === "line"
          ? ctx.child("ref", [ctx.attribute("to", { kind: "node", node, value })])
          : ctx.attribute("ref", { kind: "node", node, value });
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

  it("lowers its node types in both positions", () => {
    project(PACKAGE);
    const page = join(dir, "page.ref");
    const [sort, div] = elements(
      irOf("sort ~user.name\ndiv\n  ~user\n", undefined, page).body,
    );
    expect(attr(sort, "ref")).toMatchObject({
      value: "user.name",
      node: { type: "ref:Ref", path: ["user", "name"] },
    });
    const [ref] = elements((div as Element).children);
    expect(attr(ref, "to")).toMatchObject({
      node: { type: "ref:Ref", path: ["user"] },
    });
  });

  it("a row naming a type it does not register is an error in the dialect's module", () => {
    const pkg = project(PACKAGE.replace('"type":"Ref"', '"type":"Path"'));
    const error = caught(() => irOf("div\n", undefined, join(dir, "page.ref")));
    expect(error.file).toBe(join(pkg, "index.mjs"));
    expect([error.line, error.column]).toEqual([1, 0]);
    expect(error.message).toBe(
      '`table.attributeTriggers[0].node` (trigger "ref") names `ref:Path`, which the dialect does not register (it registers Ref)',
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
