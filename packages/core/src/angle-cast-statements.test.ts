import { describe, expect, it } from "vitest";
import { coreBabel } from "./babel.ts";
import { compileSource, printExpression } from "./compile.ts";
import { expr, newCtx, sliceNode } from "./core.ts";
import { rewriteAngleAssertions } from "./mx-parse.ts";
import { lookup } from "./test-targets.ts";

const declarations = {
  name: "statements-test",
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

describe("authored statement readers and projected printers", () => {
  it.each(["static", "server", "client"])(
    "keeps positions after a %s cast",
    (keyword) => {
      const source = `${keyword} const s = <string>(globalThis as any).a; const t = input.zz;`;
      const failure = (stripTypes: boolean) => {
        try {
          compileSource(source, "/tmp/angle-statements.mx", declarations, {
            targets: lookup,
            stripTypes,
            emitIr: () => "",
          });
        } catch (error) {
          const e = error as {
            line: number;
            column: number;
            diagnosticCode: string;
          };
          return { line: e.line, column: e.column, code: e.diagnosticCode };
        }
        throw new Error("expected the module-scope refusal");
      };
      expect(failure(false)).toEqual(failure(true));
      expect(failure(false)).toMatchObject({
        line: 1,
        column: source.indexOf("input"),
        code: "MX_RENDER_ONLY_IN_MODULE",
      });
    },
  );

  it("keeps untrimmed statement ends and never slices a positionless node from zero", () => {
    const source = "const q = <string>x; \n  ";
    const payload = coreBabel().parse(source, { plugins: ["typescript"] })
      .program.body;
    const node = {
      type: "MxModuleStatement",
      start: 0,
      end: source.trimEnd().length,
      untrimmedEnd: source.length,
      code: { type: "MxStatements", node: payload, outer: {} },
    };
    rewriteAngleAssertions({ type: "MxDocument", body: [node] });
    const ctx = newCtx(
      source,
      printExpression,
      declarations,
      undefined,
      "/tmp/angle-statement.mx",
      lookup,
    );
    expect(sliceNode(ctx, node)).toBe(source);
    // Even a tree already rewritten for tooling stays authored in runtime mode.
    expect(expr(ctx, node)).toBe(source);
    ctx.typeCheckProjection = true;
    expect(expr(ctx, node)).toBe("const q = (x as string); \n  ");
    expect(sliceNode(ctx, { type: "Synthetic", code: node.code })).toBe("");
  });
});
