// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Expression values are mapped to their authored source: a component prop
 * value, an attribute expression and a `${}` text expression each carry a
 * mapping whose source slice is the expression and whose generated slice is
 * the text emitted for it. An atom (decision 156) is one character longer in
 * the generated text, so it maps per atom. Mapping only: the emitted code is
 * the code it was before.
 */
function pairs(source: string): { code: string; pairs: string[][] } {
  const { code, mappings } = compile(source, "/fixtures/values.mx");
  return {
    code,
    pairs: mappings.map((m) => [
      source.slice(m.sourceStart, m.sourceEnd),
      code.slice(m.generatedStart, m.generatedEnd),
    ]),
  };
}

const IMPORT = 'import Field from "./field.mx"\n';

describe("html expression values", () => {
  it.each([
    ["a component prop value", `${IMPORT}<Field count=n + 1/>`, "n + 1"],
    ["a component spread", `${IMPORT}<Field ...rest/>`, "rest"],
    ["an attribute expression", "<input value=missing/>", "missing"],
    ["a class attribute", '<div class=["a", b]/>', '["a", b]'],
    ["a `${}` text expression", "<p>${missing}</p>", "missing"],
    ["a raw `$!{}` text expression", "<p>$!{missing}</p>", "missing"],
    ["an attribute beside a spread", "<div title=t ...rest/>", "t"],
    ["a textarea value", "<textarea value=v/>", "v"],
  ])("maps %s", (_name, source, expression) => {
    expect(pairs(source).pairs).toContainEqual([expression, expression]);
  });

  it.each([
    [
      "a nested atom in a component prop",
      `${IMPORT}<Field modes=[:strict, :lose]/>`,
      [":strict", ":lose"],
    ],
    ["an atom in an attribute", "<input value=f(:a, b)/>", [":a"]],
    ["an atom in a `${}` expression", "<p>${f(:t, u)}</p>", [":t"]],
    ["an atom beside a spread", "<div title=f(:a, b) ...rest/>", [":a"]],
  ])("maps %s per atom", (_name, source, atoms) => {
    const result = pairs(source);
    for (const atom of atoms) {
      expect(result.pairs).toContainEqual([
        atom,
        JSON.stringify(atom.slice(1)),
      ]);
    }
  });

  it("maps the text after an atom to its own offset, not drifted by one", () => {
    const source = "<p>${f(:t, afterAtom)}</p>";
    expect(pairs(source).pairs).toContainEqual([
      ", afterAtom)",
      ", afterAtom)",
    ]);
  });
});
