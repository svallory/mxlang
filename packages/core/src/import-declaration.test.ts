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
