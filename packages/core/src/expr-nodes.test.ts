import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { type Ctx, exprWithNodes, type Node, newCtx } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { DialectNode } from "./dialect-registry.ts";
import { nodeOfForward, recordForward } from "./expr-nodes.ts";
import { lookup } from "./test-targets.ts";

/**
 * `Expr.nodes` at the unit level: a dialect node inside an expression is
 * lowered to its forward, which the trigger pass puts in the payload and
 * splices into the authored slice (`ctx.triggerSplices`). `exprWithNodes`
 * lists each node in source order with the range its forward is printed at,
 * on both paths (no bindings: a plain splice; bindings: the reads rewrite).
 * The forwards here are built as a dialect's `lower` builds them, over the
 * stand-in Babel parsed (`0.` for `~a`); `ir-entry/atom-fixture.test.ts`
 * runs the same thing end to end through a dialect.
 */

const { parseExpression } = createRequire(import.meta.url)("@babel/parser") as {
  parseExpression: (code: string, options?: object) => Node;
};

const host: HostDeclarations = {
  name: "expr-nodes-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

/**
 * `source` with each `~name` stood in by a same-length number, parsed, each
 * stand-in replaced by a plain string literal (the forward), and one splice
 * per node recorded on the context, as the trigger pass does.
 */
function withNodes(source: string): {
  ctx: Ctx;
  node: Node;
  forwards: Node[];
} {
  const standIn = source.replace(/~[a-z][a-z0-9-]*/g, (atom) =>
    `0.${"0".repeat(atom.length - 2)}`.slice(0, atom.length),
  );
  const atoms = [...source.matchAll(/~([a-z][a-z0-9-]*)/g)].map((m) => ({
    name: m[1] as string,
    start: m.index as number,
    end: (m.index as number) + m[0].length,
  }));
  const ctx = newCtx(source, printExpression, host, undefined, "t.mx", lookup);
  ctx.triggerSplices = [];
  const forwards: Node[] = [];
  const replace = (node: Node): Node => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(replace);
    const atom = atoms.find((a) => a.start === node.start);
    if (node.type === "NumericLiteral" && atom) {
      const forward: Node = {
        type: "StringLiteral",
        start: node.start,
        end: node.end,
        value: atom.name,
        extra: { raw: JSON.stringify(atom.name), rawValue: atom.name },
      };
      const dialectNode = Object.freeze({
        type: "atom:Atom",
        name: atom.name,
        span: { sourceStart: atom.start, sourceEnd: atom.end },
      }) as unknown as DialectNode;
      ctx.triggerSplices?.push({
        start: atom.start,
        end: atom.end,
        text: JSON.stringify(atom.name),
        node: recordForward(dialectNode, forward),
      });
      forwards.push(forward);
      return forward;
    }
    const out: Node = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === "loc" ? value : replace(value);
    }
    return out;
  };
  const node = replace(parseExpression(standIn, { ranges: true }));
  return { ctx, node, forwards };
}

const printedAt = (
  code: string,
  nodes: { code?: { start: number; end: number } }[],
) => nodes.map((each) => code.slice(each.code?.start, each.code?.end));

describe("exprWithNodes", () => {
  it("lists each node in source order, with its printed range and its forward", () => {
    const { ctx, node, forwards } = withNodes("[~a, x, ~rename-all]");
    const { code, nodes } = exprWithNodes(ctx, node);
    expect(code).toBe('["a", x, "rename-all"]');
    expect(nodes.map((each) => each.type)).toEqual(["atom:Atom", "atom:Atom"]);
    expect(nodes.map((each) => each.span)).toEqual([
      { sourceStart: 1, sourceEnd: 3 },
      { sourceStart: 8, sourceEnd: 19 },
    ]);
    expect(printedAt(code, nodes)).toEqual(['"a"', '"rename-all"']);
    expect(nodes.map((each) => each.forward)).toEqual(forwards);
    expect(nodes[0]?.forward).toBe(forwards[0]);
  });

  it("the binding rewrite path keeps the ranges on the rewritten code", () => {
    const { ctx, node } = withNodes("[count, ~a, count + 1]");
    ctx.bindings.register("count", (name) => `${name}()`);
    const { code, nodes } = exprWithNodes(ctx, node);
    expect(code).toBe('[count(), "a", count() + 1]');
    expect(printedAt(code, nodes)).toEqual(['"a"']);
  });

  it("a shadowed name is not rewritten and the node still is spliced", () => {
    const { ctx, node } = withNodes("(count) => [count, ~b]");
    ctx.bindings.register("count", (name) => `${name}()`);
    const { code, nodes } = exprWithNodes(ctx, node);
    expect(code).toBe('(count) => [count, "b"]');
    expect(printedAt(code, nodes)).toEqual(['"b"']);
  });

  it("an expression with no node lists none, and a plain string is no node's forward", () => {
    const { ctx, node } = withNodes('["a", 1]');
    expect(exprWithNodes(ctx, node)).toEqual({ code: '["a", 1]', nodes: [] });
    expect(nodeOfForward((node as { elements: Node[] }).elements[0])).toBe(
      undefined,
    );
  });

  it("the forward is a plain literal: core marks nothing on it", () => {
    const { ctx, node, forwards } = withNodes("~a");
    exprWithNodes(ctx, node);
    expect(forwards[0]?.extra).toEqual({ raw: '"a"', rawValue: "a" });
    expect(nodeOfForward(forwards[0])).toMatchObject({ type: "atom:Atom" });
  });
});
