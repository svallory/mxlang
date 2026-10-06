import { parseExpression } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { cloneIr } from "./index.ts";

describe("cloneIr", () => {
  it("copies plain objects and arrays so edits never reach the original", () => {
    const original = {
      kind: "For",
      bindings: ["a"],
      children: [{ kind: "Text", value: "x" }],
    };
    const copy = cloneIr(original);
    copy.bindings.push("b");
    copy.children[0] = { kind: "Text", value: "y" };
    expect(original).toEqual({
      kind: "For",
      bindings: ["a"],
      children: [{ kind: "Text", value: "x" }],
    });
    expect(copy).not.toBe(original);
    expect(copy.bindings).not.toBe(original.bindings);
  });

  it("keeps parser nodes by reference unless asked to copy them", () => {
    const node = { type: "Identifier", name: "x" };
    const expr = { code: "x", shape: "other", node };
    expect(cloneIr(expr).node).toBe(node);
    expect(cloneIr(expr, { nodes: true }).node).not.toBe(node);
    expect(cloneIr(expr, { nodes: true }).node).toEqual(node);
    const forNode = { paramNodes: [node] };
    expect(cloneIr(forNode).paramNodes).toBe(forNode.paramNodes);
  });

  it("keeps sharing inside the original: one shared object stays one", () => {
    const shared = { code: "x", shape: "other", node: null };
    const copy = cloneIr({ a: shared, b: [shared] });
    expect(copy.a).not.toBe(shared);
    expect(copy.b[0]).toBe(copy.a);
  });

  it("shares anything that is not a plain object or array", () => {
    const map = new Map([["k", 1]]);
    const fn = () => 1;
    class Opaque {
      value = 1;
    }
    const opaque = new Opaque();
    const copy = cloneIr({ map, fn, opaque });
    expect(copy.map).toBe(map);
    expect(copy.fn).toBe(fn);
    expect(copy.opaque).toBe(opaque);
  });

  it("copes with a cycle", () => {
    const loop: { self?: unknown; n: number } = { n: 1 };
    loop.self = loop;
    const copy = cloneIr(loop);
    expect(copy.self).toBe(copy);
    expect(copy).not.toBe(loop);
  });

  it("copies a frozen IR into one that can be edited", () => {
    const frozen = Object.freeze({ list: Object.freeze(["a"]) });
    const copy = cloneIr(frozen) as { list: string[] };
    copy.list.push("b");
    expect(copy.list).toEqual(["a", "b"]);
    expect(frozen.list).toEqual(["a"]);
  });

  it("copies a real @babel/parser node (a class instance) under { nodes: true }", () => {
    const node = parseExpression("a.b + c");
    expect(Object.getPrototypeOf(node)).not.toBe(Object.prototype);
    const expr = { code: "a.b + c", shape: "other", node };
    const copy = cloneIr(expr, { nodes: true });
    expect(copy.node).not.toBe(node);
    expect(Object.getPrototypeOf(copy.node)).toBe(Object.getPrototypeOf(node));
    expect(copy.node).toEqual(node);
    const left = (node as unknown as { left: { object: object; loc: object } })
      .left;
    const copyLeft = (
      copy.node as unknown as { left: { object: object; loc: object } }
    ).left;
    expect(copyLeft).not.toBe(left);
    expect(copyLeft.object).not.toBe(left.object);
    expect(copyLeft.loc).not.toBe(left.loc);
    // Without the option the node stays shared.
    expect(cloneIr(expr).node).toBe(node);
  });
});
