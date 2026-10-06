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

  it("maps a dynamic tag's expression", () => {
    expect(pairs("<${missing}/>")).toContainEqual(["missing", "missing"]);
  });

  it.each([
    ["an index read", "<for|r, i| of=xs><p>${i + z}</p></for>", " + z"],
    ["a row read", '<for|r| of=xs by="id"><p>${r.a + z}</p></for>', ".a + z"],
    ["a for-in pair", "<for|k, v| in=o><p>${k + v + z}</p></for>", " + z"],
  ])(
    "maps the text after a rewritten read in %s one to one",
    (_name, source, tail) => {
      expect(pairs(source)).toContainEqual([tail, tail]);
    },
  );

  it("maps a replaced read as a whole, so an error on it lands on the authored name", () => {
    const result = pairs("<for|k, v| in=o><p>${k}</p></for>");
    expect(result).toContainEqual(["k", "mxEntry()[0]"]);
  });

  it("drops the `?? {}` fallback after an object literal source", () => {
    const { code } = compileSolidUnit(
      "<for|k, v| in={ a: 1 }><p>${k}</p></for>",
      {
        filename: "/fixtures/values.mx",
        customTags: {},
      },
    );
    expect(code).toContain("Object.entries({ a: 1 })");
    expect(code).not.toContain("?? {}");
  });

  it.each([
    ["an object literal", "{ a: 1 }", "{ a: 1 }"],
    ["an array literal", "[1, 2]", "[1, 2]"],
    ["a string literal", '"abc"', '"abc"'],
    ["a template literal", "`abc`", "`abc`"],
    ["a number literal", "5", "5"],
    [
      "a conditional of two literals",
      "c ? { a: 1 } : { b: 2 }",
      "c ? { a: 1 } : { b: 2 }",
    ],
    [
      "an `as` cast literal",
      "{ a: 1 } as Record<string, number>",
      "{ a: 1 } as Record<string, number>",
    ],
    [
      "a `satisfies` literal",
      "{ a: 1 } satisfies Record<string, number>",
      "{ a: 1 } satisfies Record<string, number>",
    ],
    ["a parenthesized literal", "({ a: 1 })", "{ a: 1 }"],
    ["an arithmetic", "n + 1", "n + 1"],
  ])("drops the `?? {}` fallback after %s source", (_name, source, emitted) => {
    const { code } = compileSolidUnit(
      `<for|k, v| in=${source}><p>\${k}</p></for>`,
      { filename: "/fixtures/values.mx", customTags: {} },
    );
    expect(code).toContain(`Object.entries(${emitted})`);
    expect(code).not.toContain("?? {}");
  });

  it("keeps the `?? {}` fallback after a non-literal source", () => {
    const { code } = compileSolidUnit("<for|k, v| in=o><p>${k}</p></for>", {
      filename: "/fixtures/values.mx",
      customTags: {},
    });
    expect(code).toContain("Object.entries(o ?? {})");
  });

  it.each([
    ["a member read", "o.x", "Object.entries(o.x ?? {})"],
    ["a call", "f()", "Object.entries(f() ?? {})"],
    [
      "a conditional with a name branch",
      "c ? o : { b: 2 }",
      "Object.entries((c ? o : { b: 2 }) ?? {})",
    ],
    ["a `||`", "a || b", "Object.entries((a || b) ?? {})"],
    ["an `as` cast name", "o as object", "Object.entries(o as object ?? {})"],
  ])(
    "keeps the `?? {}` fallback after %s, parenthesized when it binds looser",
    (_name, source, emitted) => {
      const { code } = compileSolidUnit(
        `<for|k, v| in=${source}><p>\${k}</p></for>`,
        { filename: "/fixtures/values.mx", customTags: {} },
      );
      expect(code).toContain(emitted);
    },
  );

  it("maps a plain mapping to text equal to its source", () => {
    for (const [source, generated] of pairs(
      `${IMPORT}<Field count=n + 1/>\n<p>\${n}</p>`,
    )) {
      expect(source).toBe(generated);
    }
  });
});
