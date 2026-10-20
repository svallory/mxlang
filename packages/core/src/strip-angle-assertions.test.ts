import { describe, expect, it } from "vitest";
import { strippedValueRoots } from "./attr-fields.ts";
import { coreBabel } from "./babel.ts";
import { compileSource } from "./compile.ts";
import type { Node } from "./core.ts";
import { stripAngleAssertions, stripMxTypes } from "./mx-parse.ts";
import { lookup } from "./test-targets.ts";

const expression = (source: string): Node =>
  coreBabel().parseExpression(source, { plugins: ["typescript"] });
const pattern = (source: string): Node =>
  coreBabel().parse(`let ${source} = input;`, { plugins: ["typescript"] })
    .program.body[0].declarations[0].id;

function documentWith(container: Node): Node {
  return { type: "MxDocument", body: [{ type: "MxTag", value: container }] };
}

const probes = [
  ["MxExpression", () => expression("(<string>input.a) as string")],
  ["MxExpression", () => expression("(<string>input.a) satisfies string")],
  ["MxExpression", () => expression("(<string>input.a)!")],
  ["MxExpression", () => expression("<string><unknown>input.a")],
  ["MxPattern", () => pattern('{ a = <string>"d" }')],
  ["MxPattern", () => pattern('[ b = (<string>"d") ]')],
  ["MxArguments", () => [expression("(<string>input.a) as string")]],
] as const;

describe("stripAngleAssertions", () => {
  it("drops tag type arguments with stripTypes:false while keeping as and satisfies", () => {
    compileSource(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MX placeholder syntax
      "<p<string> title=input.a as string>${input.a satisfies string}</p>",
      "/tmp/tag-types.mx",
      {
        name: "tag-types-test",
        tags: {},
        isElement: () => true,
        isComponent: () => false,
      },
      {
        targets: lookup,
        stripTypes: false,
        emitIr: (ir) => {
          const tag = ir.body[0];
          if (tag?.kind !== "Element") throw new Error("expected an Element");
          const attr = tag.attrs[0];
          if (attr?.kind !== "dynamic")
            throw new Error("expected a dynamic attribute");
          expect(attr.value.code).toBe("input.a as string");
          const child = tag.children[0];
          if (child?.kind !== "Interpolation")
            throw new Error("expected an Interpolation");
          expect(child.expr.code).toBe("input.a satisfies string");
          return "";
        },
      },
    );
  });

  it("keeps a method's representable type parameters", () => {
    const typeParams = { type: "MxTypeParameters", node: [], outer: {} };
    const method = { type: "MxMethod", typeParams };
    stripAngleAssertions(documentWith(method));
    expect(method.typeParams).toBe(typeParams);
  });

  it.each(probes)(
    "matches the full strip for an angle-bearing %s",
    (type, makeNode) => {
      const container = { type, node: makeNode(), outer: {} };
      const baseline = { type, node: makeNode(), outer: {} };
      stripAngleAssertions(documentWith(container));
      stripMxTypes(documentWith(baseline));
      expect(container.node).toEqual(baseline.node);
      expect(JSON.stringify(container.node)).not.toContain('"TSTypeAssertion"');
    },
  );

  it.each(["input.a as string", "input.a satisfies string", "input.a!"])(
    "leaves an angle-free wrapper unchanged: %s",
    (source) => {
      const node = expression(source);
      const container = { type: "MxExpression", node, outer: {} };
      stripAngleAssertions(documentWith(container));
      expect(container.node).toBe(node);
      expect(strippedValueRoots.has(container)).toBe(false);
    },
  );

  it.each([
    ["MxArguments", () => [expression("input.a satisfies string")]],
    ["MxPattern", () => pattern('{ a = "d" as string }')],
  ] as const)(
    "leaves an angle-free %s container unchanged",
    (type, makeNode) => {
      const node = makeNode();
      const before = JSON.stringify(node);
      const container = { type, node, outer: {} };
      stripAngleAssertions(documentWith(container));
      expect(container.node).toBe(node);
      expect(JSON.stringify(container.node)).toBe(before);
    },
  );

  it.each(["value", "args"])(
    "strips a claimed node's %s container and records its root",
    (key) => {
      const node = expression("(<string>input.a) satisfies string");
      const container = { type: "MxExpression", node, outer: {} };
      const claimed = Object.freeze({
        type: "fixture:Claim",
        [key]: container,
      });
      stripAngleAssertions({ type: "MxDocument", body: [claimed] });
      expect(container.node.type).toBe("MemberExpression");
      expect(strippedValueRoots.get(container)).toEqual({
        start: node.start,
        end: node.end,
      });
    },
  );

  it("strips a claimed node's argument-list container", () => {
    const container = {
      type: "MxArguments",
      node: [expression("<string><unknown>input.a")],
      outer: {},
    };
    stripAngleAssertions({
      type: "MxDocument",
      body: [Object.freeze({ type: "fixture:Claim", args: container })],
    });
    expect(container.node[0]?.type).toBe("MemberExpression");
  });
});
