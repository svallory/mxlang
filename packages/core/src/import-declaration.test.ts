import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { Ir } from "./ir.ts";
import { lookup } from "./test-targets.ts";

/**
 * `Import.declaration`: the Babel `ImportDeclaration` the MX front end parsed,
 * for a consumer that wants the module and the names without parsing `code`.
 * It is the author's statement, so a type-only mark survives although the
 * compile strips TypeScript from the payload before lowering.
 */

const elements: HostDeclarations = {
  name: "import-declaration-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name),
  resolveAttributeMethod: () => true,
};

function irOf(source: string, stripTypes?: boolean): Ir {
  let captured: Ir | undefined;
  compileSource(source, "/tmp/import-declaration.mx", elements, {
    targets: lookup,
    stripTypes,
    emitIr: (ir) => {
      captured = ir;
      return "";
    },
  });
  if (!captured) throw new Error("no IR captured");
  return captured;
}

describe("Import.declaration", () => {
  it("is the parsed ImportDeclaration of an authored import", () => {
    const [node] = irOf(`import d, { a as b } from "m"\n<div/>\n`).imports;
    const declaration = node?.declaration;
    expect(declaration?.type).toBe("ImportDeclaration");
    expect(declaration?.source.value).toBe("m");
    expect(
      declaration?.specifiers.map((s: { type: string }) => s.type),
    ).toEqual(["ImportDefaultSpecifier", "ImportSpecifier"]);
  });

  it("keeps import type and an inline type specifier", () => {
    const [whole, inline] = irOf(
      `import type { T } from "t"\nimport { type U, v } from "t"\n<div/>\n`,
    ).imports;
    expect(whole?.declaration?.importKind).toBe("type");
    expect(whole?.declaration?.specifiers).toHaveLength(1);
    expect(
      inline?.declaration?.specifiers.map(
        (s: { local: { name: string }; importKind?: string }) => [
          s.local.name,
          s.importKind,
        ],
      ),
    ).toEqual([
      ["U", "type"],
      ["v", "value"],
    ]);
  });

  it("is the payload itself when types are not stripped", () => {
    const [node] = irOf(`import type { T } from "t"\n<div/>\n`, false).imports;
    expect(node?.declaration?.importKind).toBe("type");
  });

  it("is absent on a synthesized import", () => {
    const ir = irOf(`<div/>\n`);
    expect(ir.imports.every((node) => node.declaration === undefined)).toBe(
      true,
    );
  });
});

const NOT_ES =
  'an `import` statement must be one ES import declaration (`import … from "…"`); `import x = …` and several statements in one `import` are not supported';
const FLOW =
  "`import typeof` is Flow syntax; imports here are TypeScript. Use `import type` for an import that binds no value";

function refusal(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    irOf(source);
  } catch (error) {
    const { message, line, column } = error as {
      message: string;
      line: number;
      column: number;
    };
    return { message, line, column };
  }
  throw new Error("expected a refusal");
}

describe("an import that is not one ES import declaration", () => {
  it.each([
    ["import-equals with an entity name", `import x = M.N\n<div/>\n`, 1],
    [
      "two statements on one line",
      `<div/>\nimport a from "a"; import b from "b"\n`,
      2,
    ],
    [
      "an indented line continuing the statement",
      `import a from "a"\n  import x = M.N\n<div/>\n`,
      1,
    ],
    [
      "import-equals require, on line 1",
      `import x = require("y")\n<div/>\n`,
      1,
    ],
    [
      "import-equals require, on line 2",
      `<div/>\nimport x = require("y")\n`,
      2,
    ],
    [
      "import type equals require, on line 3",
      `<div/>\n<div/>\nimport type X = require("y")\n`,
      3,
    ],
  ])("is refused at the statement: %s", (_, source, line) => {
    expect(refusal(source)).toEqual({ message: NOT_ES, line, column: 0 });
  });

  it("refuses import typeof", () => {
    expect(refusal(`import typeof T from "m"\n<div/>\n`)).toEqual({
      message: FLOW,
      line: 1,
      column: 0,
    });
    // Per specifier, the parser already refuses it, positioned.
    const inline = refusal(`<div/>\nimport { typeof T } from "m"\n`);
    expect(inline.line).toBe(2);
    expect(inline.message).toBe("Unexpected keyword 'typeof'.");
  });

  it("still accepts every ES import form", () => {
    for (const source of [
      `import "m"\n<div/>\n`,
      `import type { T } from "m"\n<div/>\n`,
      `import d, * as ns from "m"\n<div/>\n`,
    ]) {
      expect(irOf(source).imports[0]?.declaration?.type).toBe(
        "ImportDeclaration",
      );
    }
  });
});
