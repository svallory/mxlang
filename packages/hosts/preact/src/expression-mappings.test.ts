// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * Component prop values and `${}` text expressions are mapped to their authored
 * source on the shared JSX emitter (preact here; react and hono share it).
 * Atoms (decision 156) map per atom. Mapping only: the emitted code is
 * unchanged.
 */
function pairs(source: string): string[][] {
  const { code, mappings } = compilePreactMx(source, "/fixtures/values.mx", {
    customTags: {},
  } as never);
  return mappings.map((m) => [
    source.slice(m.sourceStart, m.sourceEnd),
    code.slice(m.generatedStart, m.generatedEnd),
  ]);
}

const IMPORT = 'import Field from "./field.mx"\n';

describe("preact expression values", () => {
  it.each([
    ["a component prop value", `${IMPORT}<Field count=n + 1/>`, "n + 1"],
    ["a component spread", `${IMPORT}<Field ...rest/>`, "rest"],
    [
      "a component class object",
      `${IMPORT}<Field class={ a: b }/>`,
      "{ a: b }",
    ],
    ["a `${}` text expression", "<p>${missing}</p>", "missing"],
    ["a lone `${}` child of an <if>", "<if=c>${missing}</if>", "missing"],
  ])("maps %s", (_name, source, expression) => {
    expect(pairs(source)).toContainEqual([expression, expression]);
  });

  it.each([
    [
      "a nested atom in a component prop",
      `${IMPORT}<Field modes=[:strict, :lose]/>`,
      [":strict", ":lose"],
    ],
    ["an atom in a `${}` expression", "<p>${f(:t, u)}</p>", [":t"]],
    ["an atom in a component spread", `${IMPORT}<Field ...f(:a)/>`, [":a"]],
  ])("maps %s per atom", (_name, source, atoms) => {
    const result = pairs(source);
    for (const atom of atoms) {
      expect(result).toContainEqual([atom, JSON.stringify(atom.slice(1))]);
    }
  });

  it("leaves a method attribute rewritten to an arrow unmapped", () => {
    const source = `${IMPORT}<Field onPick() { go() }/>`;
    const result = pairs(source);
    expect(result.some(([, generated]) => generated?.includes("=>"))).toBe(
      false,
    );
  });
});
