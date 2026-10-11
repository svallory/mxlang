import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { atomsIn, recordAtoms } from "./atom-marks.ts";
import { printExpression } from "./compile.ts";
import { type Ctx, expr, type Node, newCtx } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lookup } from "./test-targets.ts";

/**
 * The record-only atom path: core lexes no atom, a dialect's trigger lowers
 * one to a `StringLiteral` marked `extra.mxAtom = { span, name }`, and core records
 * every marked node on `ctx.atoms` so `expr()` splices each one into the
 * authored slice. The marked literals here are built as a dialect's `lower`
 * builds them, over the stand-in Babel parsed (`0.` for `~a`); the sigil is
 * the atom fixture's (`fixtures/syntax/atom-fixture.ts`), which
 * `ir-entry/atom-fixture.test.ts` runs end to end.
 */

const { parseExpression } = createRequire(import.meta.url)("@babel/parser") as {
  parseExpression: (code: string, options?: object) => Node;
};

const host: HostDeclarations = {
  name: "atom-marks-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: () => false,
  isDelegatedTag: () => false,
  resolveAttributeMethod: () => true,
};

/**
 * `source` with each `~name` stood in by a same-length number, parsed, and
 * each stand-in replaced by the marked literal a dialect's `lower` returns.
 */
function marked(source: string): { ctx: Ctx; node: Node } {
  const standIn = source.replace(/~[a-z][a-z0-9-]*/g, (atom) =>
    `0.${"0".repeat(atom.length - 2)}`.slice(0, atom.length),
  );
  const atoms = [...source.matchAll(/~([a-z][a-z0-9-]*)/g)].map((m) => ({
    name: m[1] as string,
    start: m.index as number,
  }));
  const replace = (node: Node): Node => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(replace);
    const atom = atoms.find((a) => a.start === node.start);
    if (node.type === "NumericLiteral" && atom) {
      return {
        type: "StringLiteral",
        start: node.start,
        end: node.end,
        value: atom.name,
        extra: {
          raw: JSON.stringify(atom.name),
          rawValue: atom.name,
          mxAtom: {
            name: atom.name,
            span: { sourceStart: node.start, sourceEnd: node.end },
          },
        },
      };
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "loc" && child && typeof child === "object") {
        node[key] = replace(child);
      }
    }
    return node;
  };
  const node = replace(
    parseExpression(standIn, { plugins: ["typescript"], ranges: false }),
  );
  const ctx = newCtx(
    source,
    printExpression,
    host,
    undefined,
    "/v/a.mx",
    lookup,
  );
  return { ctx, node };
}

describe("recordAtoms", () => {
  it("records each marked literal in source order", () => {
    const { ctx, node } = marked("[~b, f(~rename-all), x]");
    recordAtoms(ctx, [node]);
    expect(ctx.atoms).toEqual([
      { kind: "atom", name: "b", span: { sourceStart: 1, sourceEnd: 3 } },
      {
        kind: "atom",
        name: "rename-all",
        span: { sourceStart: 7, sourceEnd: 18 },
      },
    ]);
    expect(atomsIn(ctx, 4, 23).map((a) => a.name)).toEqual(["rename-all"]);
    expect(atomsIn(ctx, 2, 23).map((a) => a.name)).toEqual(["rename-all"]);
  });

  it("a second walk over the same tree changes nothing", () => {
    const { ctx, node } = marked("[~a, ~b]");
    recordAtoms(ctx, [node]);
    const before = structuredClone(ctx.atoms);
    const marks = (node.elements as Node[]).map((n) =>
      structuredClone(n.extra),
    );
    recordAtoms(ctx, [node]);
    expect(ctx.atoms).toEqual(before);
    (node.elements as Node[]).forEach((n, index) => {
      expect(n.type).toBe("StringLiteral");
      expect(n.extra).toEqual(marks[index]);
    });
  });

  it("records no unmarked string and no authored number", () => {
    const { ctx, node } = marked('["a", 0., 0.0]');
    recordAtoms(ctx, [node]);
    expect(ctx.atoms).toEqual([]);
    expect(expr(ctx, node)).toBe('["a", 0., 0.0]');
  });
});

describe("expr() splices recorded atoms", () => {
  it("with no binding, each atom is its string literal", () => {
    const { ctx, node } = marked("[~a, ~rename-all]");
    recordAtoms(ctx, [node]);
    expect(expr(ctx, node)).toBe('["a", "rename-all"]');
  });

  it("the binding rewrite path splices both", () => {
    const { ctx, node } = marked("[count, ~a, count + 1]");
    recordAtoms(ctx, [node]);
    ctx.bindings.register("count", (name) => `${name}()`);
    expect(expr(ctx, node)).toBe('[count(), "a", count() + 1]');
  });

  it("a shadowed name is not rewritten and the atom still is", () => {
    const { ctx, node } = marked("(count) => [count, ~b]");
    recordAtoms(ctx, [node]);
    ctx.bindings.register("count", (name) => `${name}()`);
    expect(expr(ctx, node)).toBe('(count) => [count, "b"]');
  });
});
