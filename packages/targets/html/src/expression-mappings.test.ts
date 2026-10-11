// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Expression values are mapped to their authored source: a component prop
 * value, an attribute expression and a `${}` text expression each carry a
 * mapping whose source slice is the expression and whose generated slice is
 * the text emitted for it. An atom a dialect builds is a different length in
 * the generated text, so it maps per atom: the atom rows run core's atom
 * fixture dialect (sigil `~`), re-exported by a dialect package the temp
 * project depends on, which claims `.atom.mx`. Mapping only: the emitted code
 * is the code it was before.
 */
function pairs(
  source: string,
  file = "/fixtures/values.mx",
): { code: string; pairs: string[][] } {
  const { code, mappings } = compile(source, file);
  return {
    code,
    pairs: mappings.map((m) => [
      source.slice(m.sourceStart, m.sourceEnd),
      code.slice(m.generatedStart, m.generatedEnd),
    ]),
  };
}

const MODULE = join(
  import.meta.dirname,
  "../../../core/src/fixtures/syntax/atom-fixture.ts",
);

let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-html-atom-")));
  const dialect = join(dir, "node_modules", "atom-dialect");
  mkdirSync(dialect, { recursive: true });
  writeFileSync(
    join(dialect, "package.json"),
    JSON.stringify({
      name: "atom-dialect",
      mx: {
        dialect: {
          id: "atom",
          name: "Fixture",
          extensions: [".atom.mx"],
          module: "./index.cjs",
        },
      },
    }),
  );
  writeFileSync(
    join(dialect, "index.cjs"),
    `module.exports = require(${JSON.stringify(MODULE)});\n`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      devDependencies: { "atom-dialect": "0.0.0" },
    }),
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const atomPairs = (source: string) => pairs(source, join(dir, "page.atom.mx"));

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
      `${IMPORT}<Field modes=[~strict, ~lose]/>`,
      ["~strict", "~lose"],
    ],
    ["an atom in an attribute", "<input value=f(~a, b)/>", ["~a"]],
    ["an atom in a `${}` expression", "<p>${f(~t, u)}</p>", ["~t"]],
    ["an atom beside a spread", "<div title=f(~a, b) ...rest/>", ["~a"]],
  ])("maps %s per atom", (_name, source, atoms) => {
    const result = atomPairs(source);
    for (const atom of atoms) {
      expect(result.pairs).toContainEqual([
        atom,
        JSON.stringify(atom.slice(1)),
      ]);
    }
  });

  it("maps the text after an atom to its own offset, not drifted", () => {
    const source = "<p>${f(~t, afterAtom)}</p>";
    expect(atomPairs(source).pairs).toContainEqual([
      ", afterAtom)",
      ", afterAtom)",
    ]);
  });
});
