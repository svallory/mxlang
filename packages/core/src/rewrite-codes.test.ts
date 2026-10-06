import { describe, expect, it } from "vitest";
import type { IrNode } from "./ir.ts";
import { rewriteCodes } from "./rewrite-codes.ts";

/**
 * ir-spec 10.2 E11: scopes come from `For.bindings` and `Define.params`.
 *
 * `rewriteCodes` is the one walk hosts and core share to apply a rewrite with
 * the scope in force at each `Expr`; it learns what a construct binds only from
 * those two fields.
 */

const loc = { line: 1, column: 0 };
const expr = (code: string) => ({ code, shape: "other", node: null });

/** The names each rewritten `Expr` saw shadowed, by its code. */
function shadowedAt(nodes: unknown): Record<string, string[]> {
  const seen: Record<string, string[]> = {};
  rewriteCodes(nodes, (code, _loc, shadowed) => {
    seen[code] = [...shadowed].sort();
    return code;
  });
  return seen;
}

describe("rewriteCodes scopes (E11)", () => {
  it("shadows every name in For.bindings inside the loop, not in its source", () => {
    const body = [
      {
        kind: "For",
        source: { kind: "of", list: expr("source") },
        params: ["{ a, b }", "i"],
        paramNodes: [],
        bindings: ["a", "b", "i"],
        key: expr("key"),
        children: [{ kind: "Interpolation", expr: expr("inside"), loc }],
        loc,
      },
    ] as unknown as IrNode[];
    const seen = shadowedAt(body);
    expect(seen.source).toEqual([]);
    expect(seen.inside).toEqual(["a", "b", "i"]);
  });

  it("reads the names from bindings, not from the params source text", () => {
    const body = [
      {
        kind: "For",
        source: { kind: "of", list: expr("source") },
        params: ["{ a }"],
        paramNodes: [],
        bindings: ["a", "mxRow"],
        key: null,
        children: [{ kind: "Interpolation", expr: expr("inside"), loc }],
        loc,
      },
    ] as unknown as IrNode[];
    expect(shadowedAt(body).inside).toEqual(["a", "mxRow"]);
  });

  it("shadows Define.params inside the define", () => {
    const body = [
      {
        kind: "Define",
        name: "Row",
        params: ["x", "y"],
        children: [{ kind: "Interpolation", expr: expr("inside"), loc }],
        loc,
      },
    ] as unknown as IrNode[];
    expect(shadowedAt(body).inside).toEqual(["x", "y"]);
  });

  it("a Const shadows its own name for the siblings after it, not before", () => {
    const body = [
      { kind: "Interpolation", expr: expr("before"), loc },
      { kind: "Const", name: "n", init: expr("init"), loc },
      { kind: "Interpolation", expr: expr("after"), loc },
    ] as unknown as IrNode[];
    const seen = shadowedAt(body);
    expect(seen.before).toEqual([]);
    expect(seen.init).toEqual([]);
    expect(seen.after).toEqual(["n"]);
  });

  it("visits an Expr shared by two places once", () => {
    const shared = expr("shared");
    const body = [
      { kind: "Interpolation", expr: shared, loc },
      { kind: "Interpolation", expr: shared, loc },
    ] as unknown as IrNode[];
    let calls = 0;
    rewriteCodes(body, (code) => {
      calls++;
      return `${code}!`;
    });
    expect(calls).toBe(1);
    expect(shared.code).toBe("shared!");
  });

  it("does not descend into Expr.node", () => {
    const body = [
      {
        kind: "Interpolation",
        expr: { code: "x", shape: "other", node: { code: "decoy", shape: 1 } },
        loc,
      },
    ] as unknown as IrNode[];
    expect(Object.keys(shadowedAt(body))).toEqual(["x"]);
  });
});
