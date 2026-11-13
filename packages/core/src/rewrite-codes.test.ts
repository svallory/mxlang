import { describe, expect, it } from "vitest";
import {
  freeIdentifiersInProgram,
  rewriteAccessorReads,
} from "./accessor-reads.ts";
import { compileSource } from "./compile.ts";
import { DYNAMIC_TAG } from "./core.ts";
import type { Ir, IrNode } from "./ir.ts";
import { rewriteCodes } from "./rewrite-codes.ts";
import { lookup } from "./test-targets.ts";

/**
 * ir-spec 10.2 E11: scopes come from the IR's binding fields.
 *
 * `rewriteCodes` is the one walk hosts and core share to apply a rewrite with
 * the scope in force at each `Expr`; it learns what a construct binds only from
 * `For.bindings`, `Define.bindings` (`Define.params` when absent), a block's
 * and a delegated tag's `bindings`, and a `Const`'s `varBindings`.
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

  it("does not shadow Define.params in the define's own attributes", () => {
    const body = [
      {
        kind: "Define",
        name: "Row",
        params: ["x"],
        attrs: [{ kind: "dynamic", name: "a", value: expr("outside"), loc }],
        children: [{ kind: "Interpolation", expr: expr("inside"), loc }],
        loc,
      },
    ] as unknown as IrNode[];
    const seen = shadowedAt(body);
    expect(seen.outside).toEqual([]);
    expect(seen.inside).toEqual(["x"]);
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

/**
 * A param list's names come from the IR's `bindings` (core's Babel binding
 * analysis), never from its text: `|{ n }|` rebinds `n`. Each row lowers a
 * real template, so it also proves `rewriteCodes` reads the field where
 * lowering puts it.
 */
describe("rewriteAccessorReads on lowered IR leaves a name a param list rebinds", () => {
  const dollar = "$";
  const read = (name: string) => `${dollar}{${name}}`;
  const lowered = (source: string, claimed = ""): IrNode[] => {
    let ir: Ir | null = null;
    compileSource(
      source,
      "/mx-core-test/rewrite-codes.mx",
      {
        tags: {},
        attrTags: 2,
        isElement: () => true,
        isComponent: (name, ctx) => name === "Box" || ctx.defines.has(name),
        isDelegatedTag: (name) => name === claimed,
        resolveDelegatedTag: () => ({ kind: "try" }),
      },
      {
        targets: lookup,
        tagDiscoveryDirs: [],
        emitIr(ir_) {
          ir = ir_;
          return "";
        },
      },
    );
    if (!ir) throw new Error("lowerer produced no IR");
    return (ir as Ir).body;
  };
  /** The codes `rewriteAccessorReads` leaves, in visit order. */
  const rewritten = (body: IrNode[]): string[] => {
    rewriteAccessorReads(
      body,
      new Map([["n", { read: "n()", assignError: "no" }]]),
    );
    const codes: string[] = [];
    rewriteCodes(body, (code) => {
      codes.push(code);
      return code;
    });
    return codes.filter((code) => code.startsWith("n"));
  };

  it("a block's params (`<Box|{ n }|>`)", () => {
    expect(
      rewritten(lowered(`<Box|{ n }|>${read("n")}</Box>${read("n")}`)),
    ).toEqual(["n", "n()"]);
  });

  it("a define's destructured param (`<define/D|{ n }|>`)", () => {
    expect(
      rewritten(lowered(`<define/D|{ n }|>${read("n")}</define>${read("n")}`)),
    ).toEqual(["n", "n()"]);
  });

  it("a claimed dynamic tag's params, in its body but not its attributes", () => {
    expect(
      rewritten(
        lowered(
          `<${read("input.X")}|{ n }| a=n>${read("n")}</>${read("n")}`,
          DYNAMIC_TAG,
        ),
      ),
    ).toEqual(["n()", "n", "n()"]);
  });

  it("a <try> catch's params (`<@catch|{ n }|>`)", () => {
    expect(
      rewritten(
        lowered(
          `<try>x<@catch|{ n }|>${read("n")}</@catch></try>${read("n")}`,
          "try",
        ),
      ),
    ).toEqual(["n", "n()"]);
  });

  it("an attribute-tag <for>'s params, in its nodes but not its source", () => {
    expect(
      rewritten(
        lowered(
          `<Box><for|{ n }| of=n><@item>${read("n")}</@item></for></Box>${read("n")}`,
        ),
      ),
    ).toEqual(["n()", "n", "n()"]);
  });
});

describe("freeIdentifiersInProgram", () => {
  it.each([
    ["a.Row;", ["a"]],
    ['const s = "Row";', []],
    ["Row;", ["Row"]],
    ["<Row />;", ["Row"]],
    ["<Row.a />;", ["Row"]],
    ["const f = (Row) => Row;", []],
    ["[...Row];", ["Row"]],
  ])("%s reads %j", (code, names) => {
    expect([...(freeIdentifiersInProgram(code) ?? [])]).toEqual(names);
  });

  it("is null for a text Babel cannot parse", () => {
    expect(freeIdentifiersInProgram("const = ;")).toBeNull();
  });

  it.each([
    ["<Show when={a}>{b}</Show>;", ["a", "b"]],
    ["<Foo.Bar />;", []],
    ["<li>{c}</li>;", ["c"]],
  ])("with jsxTagNames: false, %s reads %j", (code, names) => {
    expect([
      ...(freeIdentifiersInProgram(code, { jsxTagNames: false }) ?? []),
    ]).toEqual(names);
  });
});
