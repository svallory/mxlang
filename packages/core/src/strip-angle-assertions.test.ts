// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template fixtures
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { strippedValueRoots } from "./attr-fields.ts";
import { coreBabel } from "./babel.ts";
import { compileSource, printExpression } from "./compile.ts";
import { expr, type Node, newCtx } from "./core.ts";
import { parseFragment } from "./fragment.ts";
import { mappedExpr } from "./mapping.ts";
import { rewriteAngleAssertions } from "./mx-parse.ts";
import { lookup } from "./test-targets.ts";
import { withoutTsWrappers } from "./ts-unwrap.ts";

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
  ["MxExpression", () => expression("f(<string>input.a)")],
  ["MxExpression", () => expression("ok ? <string>input.a : ''")],
  ["MxExpression", () => expression("() => <string>input.a")],
  ["MxExpression", () => expression("`a${<string>input.a}`")],
  ["MxExpression", () => expression("<const>[1, 2]")],
  ["MxPattern", () => pattern('{ a = <string>"d" }')],
  ["MxPattern", () => pattern('[ b = (<string>"d") ]')],
  ["MxArguments", () => [expression("(<string>input.a) as string")]],
  ["MxParameterList", () => [pattern('{ a = <string>"d" }')]],
  [
    "MxStatements",
    () =>
      coreBabel().parse("const a = <string>input.a;", {
        plugins: ["typescript"],
      }).program.body,
  ],
] as const;

function printed(node: Node): string {
  return Array.isArray(node)
    ? node.map(printExpression).join(", ")
    : printExpression(node);
}

describe("rewriteAngleAssertions", () => {
  it.each([
    ["<string><unknown>input.a", "((input.a as unknown) as string)"],
    ["<Array<Array<string>>>input.a", "(input.a as Array<Array<string>>)"],
    [
      "<string /* > */> /* operand */ input.a",
      "( /* operand */ input.a as string /* > */)",
    ],
    ["f(<string>input.a) + 1", "f((input.a as string)) + 1"],
  ])("prints source splices directly: %s", (source, expected) => {
    const node = expression(source);
    const container = { type: "MxExpression", node, outer: {} };
    rewriteAngleAssertions(documentWith(container));
    const ctx = newCtx(
      source,
      printExpression,
      {
        tags: {},
        isElement: () => true,
        isComponent: () => false,
      },
      undefined,
      "/tmp/angle-printer.mx",
      lookup,
    );
    expect(expr(ctx, container.node)).toBe(expected);
  });
  it.each([
    ["<typeof count>input", "input"],
    ["<typeof count><number>input", "input"],
    ["f(<typeof count>input) + <number>other", "f(input) + other"],
    // Known exceptional-container fallback: unrelated binding edits are also
    // discarded when an edit overlaps the angle header. Keep TSX parseable.
    ["f(<typeof count>input) + count", "f(input) + count"],
  ])(
    "erases angle wrappers on overlapping binding edits: %s",
    (source, expected) => {
      const container = {
        type: "MxExpression",
        node: expression(source),
        outer: {},
      };
      rewriteAngleAssertions(documentWith(container));
      const ctx = newCtx(
        source,
        printExpression,
        {
          tags: {},
          isElement: () => true,
          isComponent: () => false,
        },
        undefined,
        "/tmp/angle-overlap.mx",
        lookup,
      );
      ctx.bindings.register("count", () => "count()");
      const code = expr(ctx, container.node);
      expect(code).toBe(expected);
      const file = ts.createSourceFile(
        "overlap.tsx",
        `void (${code});`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      expect(
        (file as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] })
          .parseDiagnostics,
      ).toEqual([]);
      const mappings = mappedExpr({
        code,
        node: container.node,
        shape: "other",
        span: { sourceStart: 0, sourceEnd: source.length },
      }).mappings;
      const input = mappings.find(
        (mapping) =>
          mapping.sourceStart <= source.indexOf("input") &&
          mapping.sourceEnd >= source.indexOf("input") + 5,
      );
      expect(input).toBeDefined();
      if (!input) throw new Error("missing operand mapping");
      expect(
        code.slice(
          input.generatedStart + source.indexOf("input") - input.sourceStart,
          input.generatedStart +
            source.indexOf("input") -
            input.sourceStart +
            5,
        ),
      ).toBe("input");
    },
  );

  it("retains the legacy overlapping trigger edits when no angle was rewritten", () => {
    const source = "abc";
    const ctx = newCtx(
      source,
      printExpression,
      {
        tags: {},
        isElement: () => true,
        isComponent: () => false,
      },
      undefined,
      "/tmp/no-angle-overlap.mx",
      lookup,
    );
    ctx.triggerSplices = [
      { start: 0, end: 2, text: "A" },
      { start: 1, end: 3, text: "B" },
    ];
    expect(expr(ctx, expression(source))).toBe("AB");
  });

  it("drops tag-only types while retaining checked expression wrappers", () => {
    compileSource(
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

  it("rewrites the inert id value without changing its operand positions", () => {
    const source = "<id=(<string>input.zz)/>";
    const { body } = parseFragment(source, { rewriteAngleAssertions: true });
    const value = body[0].attributes[0].value.node;
    expect(value.type).toBe("ParenthesizedExpression");
    expect(printExpression(value)).toContain("input.zz as string");
    expect(value.expression.expression.start).toBe(source.indexOf("input.zz"));
    expect(value.expression.typeAnnotation.start).toBe(
      source.indexOf("string"),
    );
  });

  it("keeps a method's representable type parameters", () => {
    const typeParams = { type: "MxTypeParameters", node: [], outer: {} };
    const method = { type: "MxMethod", typeParams };
    rewriteAngleAssertions(documentWith(method));
    expect(method.typeParams).toBe(typeParams);
  });

  it.each(probes)(
    "rewrites every angle in %s without erasing other types",
    (type, makeNode) => {
      const container = { type, node: makeNode(), outer: {} };
      rewriteAngleAssertions(documentWith(container));
      expect(JSON.stringify(container.node)).not.toContain('"TSTypeAssertion"');
      expect(JSON.stringify(container.node)).toContain('"TSAsExpression"');
      expect(strippedValueRoots.has(container)).toBe(false);
      const code = printed(container.node);
      const wrapped =
        type === "MxPattern"
          ? `let ${code} = input;`
          : type === "MxParameterList"
            ? `const f = (${code}) => {};`
            : type === "MxStatements"
              ? code
              : `void (${code});`;
      const file = ts.createSourceFile(
        "projection.tsx",
        wrapped,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      expect(
        (file as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] })
          .parseDiagnostics,
      ).toEqual([]);
    },
  );

  it("does not unwrap dialect parentheses that the projection did not create", () => {
    const operand = expression("() => 1");
    const node = { type: "ParenthesizedExpression", expression: operand };
    expect(withoutTsWrappers(node)).toBe(node);
    expect(
      withoutTsWrappers({ type: "TSAsExpression", expression: node }),
    ).toBe(node);
  });

  it("preserves operand and type positions and the assertion's precedence", () => {
    const node = expression("<string>input.a + input.b");
    const operand = node.left.expression;
    const annotation = node.left.typeAnnotation;
    const container = { type: "MxExpression", node, outer: {} };
    rewriteAngleAssertions(documentWith(container));
    expect(container.node.left.expression.expression).toBe(operand);
    expect(withoutTsWrappers(container.node.left)).toBe(operand);
    expect(container.node.left.expression.typeAnnotation).toBe(annotation);
    expect(printed(container.node)).toBe("(input.a as string) + input.b");
  });

  it.each(["input.a as string", "input.a satisfies string", "input.a!"])(
    "leaves angle-free %s unchanged",
    (source) => {
      const node = expression(source);
      const before = JSON.stringify(node);
      const container = { type: "MxExpression", node, outer: {} };
      rewriteAngleAssertions(documentWith(container));
      expect(container.node).toBe(node);
      expect(JSON.stringify(node)).toBe(before);
      expect(strippedValueRoots.has(container)).toBe(false);
    },
  );

  it.each([
    ["MxArguments", () => [expression("input.a as string")]],
    ["MxPattern", () => pattern('{ a = "d" as string }')],
  ] as const)("leaves an angle-free %s container unchanged", (type, make) => {
    const node = make();
    const before = JSON.stringify(node);
    const container = { type, node, outer: {} };
    rewriteAngleAssertions(documentWith(container));
    expect(container.node).toBe(node);
    expect(JSON.stringify(node)).toBe(before);
    expect(strippedValueRoots.has(container)).toBe(false);
  });

  it("rewrites an argument-list container inside a frozen claim", () => {
    const container = {
      type: "MxArguments",
      node: [expression("f(<string>input.a) satisfies string")],
      outer: {},
    };
    rewriteAngleAssertions({
      type: "MxDocument",
      body: [Object.freeze({ type: "fixture:Claim", args: container })],
    });
    expect(printed(container.node)).toContain("as string");
    expect(printed(container.node)).toContain("satisfies string");
    expect(strippedValueRoots.has(container)).toBe(false);
  });

  it.each(["value", "args"])(
    "rewrites a frozen claimed node's %s container",
    (key) => {
      const container = {
        type: "MxExpression",
        node: expression("(<string>input.a) satisfies string"),
        outer: {},
      };
      rewriteAngleAssertions({
        type: "MxDocument",
        body: [Object.freeze({ type: "fixture:Claim", [key]: container })],
      });
      expect(printed(container.node)).toContain("as string");
      expect(printed(container.node)).toContain("satisfies string");
      expect(strippedValueRoots.has(container)).toBe(false);
    },
  );
});
