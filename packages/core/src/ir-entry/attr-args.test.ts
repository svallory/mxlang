/**
 * Attribute arguments on the IR (`x a(b)`): an attribute keeps the arguments
 * it was written with (`a(b)` is not read as a boolean `a`, `a(&b)` keeps its
 * member). `args` mirrors `DelegatedTag.args`, is present only when the
 * parentheses were written, and the method shorthand (`a(x) { … }`) stays a
 * function value, never `args`.
 */
import { describe, expect, it } from "vitest";
import type { Attr, DelegatedTag } from "../ir.ts";
import memberSyntax from "../syntax/member.ts";
import { type LowerSourceOptions, lowerSource, type Spanned } from "./index.ts";

function firstTag(
  source: string,
  options: LowerSourceOptions = {},
): Spanned<DelegatedTag> {
  const result = lowerSource(source, "/v/a.mx", options);
  expect(result.diagnostics).toEqual([]);
  const node = result.ir?.body[0];
  if (node?.kind !== "DelegatedTag") throw new Error("no tag");
  return node.tag;
}

function attr(tag: Spanned<DelegatedTag>, name: string): Attr {
  const found = tag.attrs.find((a) => a.kind !== "spread" && a.name === name);
  if (!found) throw new Error(`no attribute ${name}`);
  return found;
}

const argsOf = (a: Attr) =>
  "args" in a ? a.args?.map((arg) => arg.code) : undefined;

describe("attribute arguments", () => {
  it("`a(b)` is one argument", () => {
    const a = attr(firstTag("x a(b)\n"), "a");
    expect(a.kind).toBe("boolean");
    expect(argsOf(a)).toEqual(["b"]);
  });

  it("`a(b, c)` keeps both, in order, with spans", () => {
    const source = "x a(b, c)\n";
    const a = attr(firstTag(source), "a");
    const args = "args" in a ? (a.args ?? []) : [];
    expect(args.map((arg) => arg.code)).toEqual(["b", "c"]);
    expect(
      args.map((arg) =>
        source.slice(arg.span?.sourceStart, arg.span?.sourceEnd),
      ),
    ).toEqual(["b", "c"]);
    expect(args[0]?.node).toMatchObject({ type: "Identifier", name: "b" });
  });

  it("`a()` is present and empty", () => {
    expect(argsOf(attr(firstTag("x a()\n"), "a"))).toEqual([]);
  });

  it("`a(&b)` carries the member the syntax module built", () => {
    const a = attr(firstTag("x a(&b)\n", { syntax: memberSyntax }), "a");
    const [arg] = "args" in a ? (a.args ?? []) : [];
    expect(arg?.code).toBe("self.b");
    expect(arg?.node).toMatchObject({
      extra: { mxMember: { name: "b" } },
    });
  });

  it("an attribute written without parentheses has no `args` key", () => {
    const tag = firstTag('x a b=1 c="s"\n');
    for (const name of ["a", "b", "c"]) {
      expect("args" in attr(tag, name)).toBe(false);
    }
  });

  it("the method shorthand stays a function value, not `args`", () => {
    const a = attr(firstTag("x isOverdue(p) { return p }\n"), "isOverdue");
    expect(a.kind).toBe("dynamic");
    expect("args" in a).toBe(false);
    if (a.kind !== "dynamic") throw new Error(a.kind);
    expect(a.value.node).toMatchObject({ type: "FunctionExpression" });
  });

  it("the method shorthand with no params is unchanged too", () => {
    const a = attr(firstTag("x go() { return 1 }\n"), "go");
    expect(a.kind).toBe("dynamic");
    expect("args" in a).toBe(false);
  });
});
