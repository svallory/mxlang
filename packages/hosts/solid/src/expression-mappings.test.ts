// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { describe, expect, it } from "vitest";
import { compileSolidUnit } from "./index.ts";

/**
 * A whole-file Solid unit records the mapping of every expression value, so a
 * TypeScript error inside one reaches the author's source (without them
 * `mx-tsc` and the editor reported nothing for the unit). Atoms (decision 156)
 * map per atom. Mapping only: the emitted code is unchanged.
 */
function pairs(source: string): string[][] {
  const { code, mappings } = compileSolidUnit(source, {
    filename: "/fixtures/values.mx",
    customTags: {},
  });
  return mappings.map((m) => [
    source.slice(m.sourceStart, m.sourceEnd),
    code.slice(m.generatedStart, m.generatedEnd),
  ]);
}

const IMPORT = 'import Field from "./field.mx"\n';

describe("solid expression values", () => {
  it.each([
    ["a component prop value", `${IMPORT}<Field count=n + 1/>`, "n + 1"],
    ["a component spread", `${IMPORT}<Field ...rest/>`, "rest"],
    ["a native attribute value", "<input value=n + 1/>", "n + 1"],
    ["a native spread", "<p ...rest/>", "rest"],
    ["a class value", "<p class=cls/>", "cls"],
    ["a `${}` text expression", "<p>${missing}</p>", "missing"],
    ["a lone `${}` child of an <if>", "<if=c>${missing}</if>", "missing"],
    ["an <if> condition", "<if=missing><p/></if>", "missing"],
    ["a <for of=> list", "<for|x| of=missing><p/></for>", "missing"],
    ["a <for in=> object", "<for|k, v| in=missing><p/></for>", "missing"],
    ["a `$!{}` raw child", "<div>$!{missing}</div>", "missing"],
    [
      "a static block",
      "static const x: number = 1;\n<p/>",
      "const x: number = 1;",
    ],
    [
      "an import",
      'import { a } from "./a.ts"\n<p/>',
      'import { a } from "./a.ts"',
    ],
    [
      "the Input interface",
      "export interface Input { a: string }\n<p/>",
      "export interface Input { a: string }",
    ],
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
    ["an atom in a native attribute", "<input value=f(:a)/>", [":a"]],
    ["an atom in a component spread", `${IMPORT}<Field ...f(:a)/>`, [":a"]],
  ])("maps %s per atom", (_name, source, atoms) => {
    const result = pairs(source);
    for (const atom of atoms) {
      expect(result).toContainEqual([atom, JSON.stringify(atom.slice(1))]);
    }
  });

  it("leaves a method attribute rewritten to an arrow unmapped", () => {
    const result = pairs(`${IMPORT}<Field onPick() { go() }/>`);
    expect(result.some(([, generated]) => generated?.includes("=>"))).toBe(
      false,
    );
  });

  it("maps a plain mapping to text equal to its source", () => {
    for (const [source, generated] of pairs(
      `${IMPORT}<Field count=n + 1/>\n<p>\${n}</p>`,
    )) {
      expect(source).toBe(generated);
    }
  });
});
