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
import { compilePreactMx } from "./index.ts";

/**
 * Component prop values and `${}` text expressions are mapped to their authored
 * source on the shared JSX emitter (preact here; react and hono share it).
 * An atom a dialect builds maps per atom (core's atom fixture, below).
 * Mapping only: the emitted code is unchanged.
 */
function pairs(source: string, file = "/fixtures/values.mx"): string[][] {
  const { code, mappings } = compilePreactMx(source, file, {
    customTags: {},
  } as never);
  return mappings.map((m) => [
    source.slice(m.sourceStart, m.sourceEnd),
    code.slice(m.generatedStart, m.generatedEnd),
  ]);
}

const IMPORT = 'import Field from "./field.mx"\n';

const MODULE = join(
  import.meta.dirname,
  "../../../core/src/fixtures/syntax/atom-fixture.ts",
);

/**
 * A temp project depending on a dialect package whose module re-exports
 * core's atom fixture (sigil `~`), claiming `.atom.mx`.
 */
let dir: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-preact-atom-")));
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
      `${IMPORT}<Field modes=[~strict, ~lose]/>`,
      ["~strict", "~lose"],
    ],
    ["an atom in a `${}` expression", "<p>${f(~t, u)}</p>", ["~t"]],
    ["an atom in a component spread", `${IMPORT}<Field ...f(~a)/>`, ["~a"]],
  ])("maps %s per atom", (_name, source, atoms) => {
    const result = pairs(source, join(dir, "page.atom.mx"));
    for (const atom of atoms) {
      expect(result).toContainEqual([atom, JSON.stringify(atom.slice(1))]);
    }
  });

  it("maps a shorthand class placeholder onto its own source under typeCheck", () => {
    const source = "<div.a${y}.b/>";
    const { code, mappings } = compilePreactMx(source, "/fixtures/values.mx", {
      typeCheck: true,
    });
    const at = code.indexOf('[`a${y}`, "b"]') + 5;
    expect(code[at]).toBe("y");
    expect(
      mappings.filter((m) => m.generatedStart <= at && at < m.generatedEnd),
    ).toEqual([
      {
        sourceStart: 8,
        sourceEnd: 9,
        generatedStart: at,
        generatedEnd: at + 1,
      },
    ]);
  });

  it.each([
    [
      "a function-valued component prop",
      `${IMPORT}<Field onPick=function () { go() }/>`,
      ["function () { go() }"],
    ],
    [
      "a method-shorthand component prop's body",
      `${IMPORT}<Field onPick() { go() }/>`,
      ["{ go()"],
    ],
    ["a `$!{}` sole child of an element", "<div>$!{html}</div>", ["html"]],
    [
      "a `$!{}` sole child of a component",
      `${IMPORT}<Field>$!{html}</Field>`,
      ["html"],
    ],
    [
      "a structured class and the names beside a spread",
      "<div ...rest class=[a, b] data-x=y/>",
      ["class", "[a, b]", "data-x", "y"],
    ],
    [
      "a structured class passed to a define",
      "<define/Row|input: any|><p/></define><Row class=[a, b]/>",
      ["[a, b]"],
    ],
    [
      "<if> and <else-if> conditions",
      "<if=c>x</if><else-if=d>y</else-if>",
      ["c", "d"],
    ],
    ["a <for of> list", "<for|x| of=list>${x}</for>", ["list"]],
    ["a <for in> object", "<for|k| in=obj>${k}</for>", ["obj"]],
    [
      "a range <for>'s bounds and step",
      "<for|i| from=a to=b step=s>${i}</for>",
      ["a", "b", "s"],
    ],
    [
      "a function-form by=",
      "<for|x| of=list by=(x) => x.id>${x}</for>",
      ["(x) => x.id"],
    ],
    [
      "attribute-tag <if> and <for> values",
      `${IMPORT}<Field><if=c><@item/></if><for|x| of=list><@row/></for></Field>`,
      ["c", "list"],
    ],
  ])("maps %s onto its authored text", (_name, source, expressions) => {
    const result = pairs(source);
    for (const expression of expressions) {
      expect(result).toContainEqual([expression, expression]);
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
