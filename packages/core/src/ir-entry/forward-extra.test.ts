/**
 * A forward's `extra` passes through lowering unchanged (spec §13.9.9). A
 * dialect keeps its own marks there (`extra.mxTransaction` on the literal its
 * node type lowers to) and reads them back at each place a consumer sees the
 * forward. Core reserves no `extra` key on a forward, whatever its prefix,
 * and does not strip, rename or rewrite one.
 *
 * What core guarantees is identity: from the type's `lower` to every consumer
 * read the forward is the one object the dialect returned, so the dialect's
 * `extra` is the same object too (`toBe`, not only `toEqual`). The one place
 * that copies is `cloneIr(ir, { nodes: true })`, which a caller asks for to
 * edit parser nodes; there the keys and values are deep-equal and the objects
 * are fresh.
 *
 * The consumer reads, in order along the path (file:line in the report of the
 * task that added this file):
 *
 * 1. the payload: `Expr.node` holds the forward where the node was written;
 * 2. `Expr.nodes[].forward`, the `ExprNode` entry core records beside it;
 * 3. the `LoweredUnit` a dialect's `afterLower` receives
 *    (`ContractExpression.node` and `.nodes[].forward`);
 * 4. `nodeOfForward`, which finds the node by the forward's identity;
 * 5. `cloneIr`, with and without `{ nodes: true }`.
 *
 * It uses a fixture dialect (the atom fixture with its node type's `lower`
 * replaced), never a real one.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { cloneIr } from "../clone-ir.ts";
import type { CustomTag } from "../custom-tags.ts";
import { nodeOfForward } from "../expr-nodes.ts";
import type { Expr, ExprNode } from "../ir.ts";
import type { ContractExpression, LoweredUnit } from "../lowered-unit.ts";
import type { Dialect } from "../syntax-table.ts";
import { lowerSource } from "./index.ts";

const MODULE = new URL("../fixtures/syntax/atom-fixture.ts", import.meta.url)
  .pathname;
const atomSyntax = (
  createRequire(import.meta.url)(MODULE) as { default: Dialect }
).default;

/** The marks a dialect keeps on its forward: a primitive, an object and an array. */
const MARKS = () => ({
  mxTransaction: "tx-7",
  mxNested: { phase: { name: "commit", steps: [1, 2] }, retries: 3 },
  mxList: ["a", { b: true }, [null]],
  mxFlag: false,
  mxCount: 0,
  plain: "kept",
});

const PICK: Record<string, CustomTag> = {
  pick: { attributes: { n: {} } } as unknown as CustomTag,
};

/** The fixture dialect whose `Atom` lowers to a literal carrying `MARKS()` in `extra`. */
function markedDialect(seen: { unit?: LoweredUnit }): Dialect {
  const atom = (atomSyntax.nodeTypes as Record<string, object>).Atom;
  return {
    ...atomSyntax,
    nodeTypes: {
      Atom: {
        ...atom,
        lower: (
          node: { name: string },
          ctx: { expression: (node: object) => unknown },
        ) =>
          ctx.expression({
            type: "StringLiteral",
            value: node.name,
            extra: {
              raw: JSON.stringify(node.name),
              rawValue: node.name,
              ...MARKS(),
            },
          }),
      },
    },
    afterLower: (unit: LoweredUnit) => {
      seen.unit = unit;
    },
  } as unknown as Dialect;
}

function lowered(source: string) {
  const seen: { unit?: LoweredUnit } = {};
  const result = lowerSource(source, "/v/entity.mx", {
    dialect: markedDialect(seen),
    customTags: PICK,
  });
  expect(result.diagnostics).toEqual([]);
  const call = result.ir?.body[0] as unknown as {
    tag?: { attrs: { kind: string; value: Expr }[] };
    attrs?: { kind: string; value: Expr }[];
  };
  const attr = (call.tag?.attrs ?? call.attrs ?? [])[0];
  if (attr?.kind !== "dynamic") throw new Error(String(attr?.kind));
  const contract = seen.unit?.calls[0]?.attrs[0];
  if (!contract || "spread" in contract) throw new Error("no contract attr");
  return {
    ir: result.ir,
    value: attr.value,
    contract: contract.value as ContractExpression,
  };
}

/** The forward the payload holds for `n=(x + ~b)`. */
const forwardOf = (value: Expr) =>
  (value.node as unknown as { right: { extra: Record<string, unknown> } })
    .right;

describe("a forward's `extra` passes through lowering unchanged", () => {
  const SOURCE = "<pick n=(x + ~b)/>\n";

  it("the payload's forward carries every key the dialect set, with the same values", () => {
    const { value } = lowered(SOURCE);
    expect(value.code).toBe('x + "b"');
    expect(forwardOf(value).extra).toEqual({
      raw: '"b"',
      rawValue: "b",
      ...MARKS(),
    });
  });

  it("a primitive, a nested object and an array each keep their value", () => {
    const { extra } = forwardOf(lowered(SOURCE).value);
    expect(extra.mxTransaction).toBe("tx-7");
    expect(extra.mxFlag).toBe(false);
    expect(extra.mxCount).toBe(0);
    expect(extra.mxNested).toEqual(MARKS().mxNested);
    expect(extra.mxList).toEqual(MARKS().mxList);
  });

  it("a key with the `mx` prefix is not stripped: core reserves none on a forward", () => {
    const { extra } = forwardOf(lowered(SOURCE).value);
    expect(Object.keys(extra).filter((key) => key.startsWith("mx"))).toEqual([
      "mxTransaction",
      "mxNested",
      "mxList",
      "mxFlag",
      "mxCount",
    ]);
    // A key without the prefix is no different.
    expect(extra.plain).toBe("kept");
  });

  it("core adds no key of its own to the forward's `extra`", () => {
    const { extra } = forwardOf(lowered(SOURCE).value);
    expect(Object.keys(extra).sort()).toEqual(
      ["raw", "rawValue", ...Object.keys(MARKS())].sort(),
    );
  });

  it("`Expr.nodes[].forward` is the payload's forward: the same `extra` object", () => {
    const { value } = lowered(SOURCE);
    const [entry] = value.nodes as ExprNode[];
    const forward = forwardOf(value);
    expect(entry?.forward).toBe(forward);
    expect((entry as ExprNode).forward.extra).toEqual(forward.extra);
    expect(forward.extra.mxNested).toEqual(MARKS().mxNested);
  });

  it("`nodeOfForward` finds the node by the forward, whatever its `extra` holds", () => {
    const { value } = lowered(SOURCE);
    expect(nodeOfForward(forwardOf(value))).toMatchObject({
      type: "atom:Atom",
      name: "b",
    });
  });

  it("the `LoweredUnit` a module's `afterLower` sees holds the same forward and `extra`", () => {
    const { value, contract } = lowered(SOURCE);
    const forward = forwardOf(value);
    expect(contract.node).toBe(value.node);
    expect(contract.nodes?.[0]?.forward).toBe(forward);
    const seen = contract.nodes?.[0]?.forward as unknown as {
      extra: Record<string, unknown>;
    };
    expect(seen.extra).toEqual(forward.extra);
    expect(seen.extra.mxTransaction).toBe("tx-7");
    expect(seen.extra.mxList).toEqual(MARKS().mxList);
  });

  it("the mark survives where the node is written in a list and in a method value", () => {
    const list = lowered("<pick n=[~a, x, ~c]/>\n").value;
    expect(list.nodes).toHaveLength(2);
    for (const each of list.nodes ?? []) {
      expect((each.forward as { extra: object }).extra).toEqual({
        raw: expect.any(String),
        rawValue: expect.any(String),
        ...MARKS(),
      });
    }
    const method = lowered("<pick n(e) { return [~a] }/>\n").value;
    expect(method.nodes).toHaveLength(1);
    const [first] = method.nodes as ExprNode[];
    expect(first?.forward.extra?.mxTransaction).toBe("tx-7");
  });

  it("a name binding in scope (the rewritten-reference path) leaves the forward's `extra` alone", () => {
    const source = "<const/count=1>\n<pick n=[count, ~b]/>\n";
    const result = lowerSource(source, "/v/entity.mx", {
      dialect: markedDialect({}),
      customTags: PICK,
    });
    expect(result.diagnostics).toEqual([]);
    const pick = result.ir?.body[1] as unknown as {
      tag?: { attrs: { value: Expr }[] };
      attrs?: { value: Expr }[];
    };
    const value = (pick.tag?.attrs ?? pick.attrs ?? [])[0]?.value as Expr;
    const forward = value.nodes?.[0]?.forward as unknown as {
      extra: Record<string, unknown>;
    };
    expect(forward.extra.mxTransaction).toBe("tx-7");
    expect(forward.extra.mxNested).toEqual(MARKS().mxNested);
  });

  describe("cloneIr", () => {
    it("keeps the forward, and so its `extra`, by reference", () => {
      const { ir, value } = lowered(SOURCE);
      const copy = cloneIr(ir);
      const copied = findExpr(copy);
      expect(forwardOf(copied).extra).toEqual(forwardOf(value).extra);
      expect(copied.nodes?.[0]?.forward).toBe(forwardOf(value));
    });

    it("with `{ nodes: true }` copies it, keys and values deep-equal", () => {
      const { ir, value } = lowered(SOURCE);
      const copy = cloneIr(ir, { nodes: true });
      const copied = forwardOf(findExpr(copy));
      expect(copied).not.toBe(forwardOf(value));
      expect(copied.extra).not.toBe(forwardOf(value).extra);
      expect(copied.extra).toEqual(forwardOf(value).extra);
      expect(copied.extra.mxList).toEqual(MARKS().mxList);
    });
  });
});

/** The first dynamic attribute's `Expr` in a lowered IR. */
function findExpr(ir: unknown): Expr {
  const call = (ir as { body: unknown[] }).body[0] as {
    tag?: { attrs: { value: Expr }[] };
    attrs?: { value: Expr }[];
  };
  return (call.tag?.attrs ?? call.attrs ?? [])[0]?.value as Expr;
}

/**
 * The other way a dialect sets a mark: a `{ call }` expression row whose
 * `lowerTrigger` returns `ctx.expression(node)` with `extra` on it (no node
 * type, so no entry in `Expr.nodes`). The row has Mesh's shape (`%.name`, an
 * identifier stand-in, a marked `MemberExpression`), not Mesh's module.
 */
const TX = Object.freeze({
  id: "tx",
  chars: "%",
  match: "%\\.[a-z]+",
  standIn: "identifier",
  node: Object.freeze({ call: "tx" }),
});
const TX_MARK = () => ({
  mxTransaction: { span: { sourceStart: 0, sourceEnd: 1 }, name: "now" },
  mxList: ["a", { b: [1] }],
  mxFlag: false,
});

function callRowDialect(seen: { unit?: LoweredUnit }): Dialect {
  return {
    id: "txf",
    name: "TxFixture",
    table: Object.freeze({ expressionTriggers: [TX] }),
    lowerTrigger: (
      _id: string,
      text: string,
      _span: unknown,
      ctx: { expression: (node: object) => unknown },
    ) =>
      ctx.expression({
        type: "MemberExpression",
        object: { type: "Identifier", name: "%" },
        property: { type: "Identifier", name: text.slice(2) },
        computed: false,
        extra: TX_MARK(),
      }),
    afterLower: (unit: LoweredUnit) => {
      seen.unit = unit;
    },
  } as unknown as Dialect;
}

function loweredCall(source: string) {
  const seen: { unit?: LoweredUnit } = {};
  const result = lowerSource(source, "/v/entity.mx", {
    dialect: callRowDialect(seen),
    customTags: PICK,
  });
  expect(result.diagnostics).toEqual([]);
  const value = findExpr(result.ir);
  const contract = seen.unit?.calls[0]?.attrs[0];
  if (!contract || "spread" in contract) throw new Error("no contract attr");
  return {
    ir: result.ir,
    value,
    contract: contract.value as ContractExpression,
  };
}

type Marked = { extra: Record<string, unknown> };
const insideOf = (value: Expr) =>
  (value.node as unknown as { left: Marked }).left;

describe("the `extra` of a `ctx.expression` node from a `{ call }` row passes through", () => {
  const INSIDE = "<pick n=(%.now + 1)/>\n";
  const WHOLE = "<pick n=%.now/>\n";

  it("inside an expression, the payload's node keeps every key", () => {
    const { value } = loweredCall(INSIDE);
    expect(value.code).toBe("%.now + 1");
    expect(insideOf(value).extra).toEqual(TX_MARK());
  });

  it("as the whole value, `Expr.node` keeps every key", () => {
    const { value } = loweredCall(WHOLE);
    expect((value.node as unknown as Marked).extra).toEqual(TX_MARK());
  });

  it("the `LoweredUnit` node is the payload's node with the same marks", () => {
    for (const source of [INSIDE, WHOLE]) {
      const { value, contract } = loweredCall(source);
      expect(contract.node).toBe(value.node);
      const marked =
        source === WHOLE
          ? (contract.node as unknown as Marked)
          : insideOf(contract as unknown as Expr);
      expect(marked.extra).toEqual(TX_MARK());
    }
  });

  it("`cloneIr` keeps the node by reference, and `{ nodes: true }` copies its marks", () => {
    const { ir, value } = loweredCall(INSIDE);
    expect(insideOf(findExpr(cloneIr(ir)))).toBe(insideOf(value));
    expect(insideOf(findExpr(cloneIr(ir))).extra).toEqual(TX_MARK());
    const copied = insideOf(findExpr(cloneIr(ir, { nodes: true })));
    expect(copied).not.toBe(insideOf(value));
    expect(copied.extra).toEqual(TX_MARK());
  });
});
