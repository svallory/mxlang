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
import type { CustomTag } from "@mxlang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

/**
 * A whole-file Solid unit records the mapping of every expression value, so a
 * TypeScript error inside one reaches the author's source (without them
 * `mx-tsc` and the editor reported nothing for the unit). An atom a dialect
 * builds maps per atom (core's atom fixture, below). Mapping only: the
 * emitted code is unchanged.
 */
function pairs(source: string, filename = "/fixtures/values.mx"): string[][] {
  const { code, mappings } = compileSolidUnit(source, {
    filename,
    customTags: {},
  });
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-solid-atom-")));
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

/**
 * The authored text a generated `needle` maps to: the first mapping whose
 * generated text contains it, offset into its source by the same amount
 * (adjacent one-to-one runs are merged, so a token rarely has its own).
 */
function authoredAt(source: string, needle: string): string | undefined {
  const { code, mappings } = compileSolidUnit(source, {
    filename: "/fixtures/values.mx",
    customTags: {},
  });
  for (const m of mappings) {
    const at = code.slice(m.generatedStart, m.generatedEnd).indexOf(needle);
    if (at < 0) continue;
    const start = m.sourceStart + at;
    return source.slice(start, start + needle.length);
  }
  return undefined;
}

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
      `${IMPORT}<Field modes=[~strict, ~lose]/>`,
      ["~strict", "~lose"],
    ],
    ["an atom in a `${}` expression", "<p>${f(~t, u)}</p>", ["~t"]],
    ["an atom in a native attribute", "<input value=f(~a)/>", ["~a"]],
    ["an atom in a component spread", `${IMPORT}<Field ...f(~a)/>`, ["~a"]],
  ])("maps %s per atom", (_name, source, atoms) => {
    const result = pairs(source, join(dir, "page.atom.mx"));
    for (const atom of atoms) {
      expect(result).toContainEqual([atom, JSON.stringify(atom.slice(1))]);
    }
  });

  it("maps a method attribute's body, not its rewritten head", () => {
    const result = pairs(`${IMPORT}<Field onPick() { go(); }/>`);
    expect(result.some(([, generated]) => generated?.includes("=>"))).toBe(
      false,
    );
    expect(result).toContainEqual(["{ go(); }", "{ go(); }"]);
  });

  it("maps a method body the printer reformatted token by token", () => {
    // `{ go() }` prints with a `;` the author did not write: the unchanged
    // tokens map one to one, so `go` lands on the authored `go`.
    const source = `${IMPORT}<Field onPick() { go() }/>`;
    const result = pairs(source);
    expect(authoredAt(source, "go()")).toBe("go()");
    expect(result.some(([, generated]) => generated?.includes("=>"))).toBe(
      false,
    );
    for (const [authored, generated] of result) {
      if (authored?.length === generated?.length) {
        expect(authored).toBe(generated);
      }
    }
  });

  it("maps a method body whose reads were rewritten inside <for>", () => {
    const source = `${IMPORT}<for|row| of=xs by="id"><Field onPick() { use(row.id) }/></for>`;
    expect(authoredAt(source, "use(")).toBe("use(");
    expect(authoredAt(source, ".id)")).toBe(".id)");
  });

  it("maps a method body with nested blocks at the authored positions", () => {
    const source = `${IMPORT}<Field onPick() { if (c) { for (const n of xs) { go(n) } } }/>`;
    expect(authoredAt(source, "if (c) {")).toBe("if (c) {");
    expect(authoredAt(source, "go(n)")).toBe("go(n)");
    const result = pairs(source);
    expect(result.some(([, generated]) => generated?.includes("=>"))).toBe(
      false,
    );
  });

  it.each([
    ["an async method with await", "async onPick() { await go() }", "go()"],
    ["a generic method", "onPick<T>(x: T) { if (x) { go(x) } }", "go(x)"],
    [
      "a named function value, as written",
      "onPick=function tick(n: number) { if (n) { tick(n - 1) } }",
      "tick(n - 1)",
    ],
  ])("maps %s at the authored position", (_name, attr, needle) => {
    const source = `${IMPORT}<Field ${attr}/>`;
    expect(authoredAt(source, needle)).toBe(needle);
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
    expect(result).toContainEqual(["k", "__mxEntry0()[0]"]);
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
    [
      "`null`, still defaulted so it renders nothing",
      "null",
      "Object.entries(null ?? {})",
    ],
    ["a comma expression", "(o, { a: 1 })", "Object.entries((o, { a: 1 }))"],
    [
      "a comma expression ending in a name",
      "(a, o)",
      "Object.entries((a, o) ?? {})",
    ],
  ])("emits %s as one argument", (_name, source, emitted) => {
    const { code } = compileSolidUnit(
      `<for|k, v| in=${source}><p>\${k}</p></for>`,
      { filename: "/fixtures/values.mx", customTags: {} },
    );
    expect(code).toContain(emitted);
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

describe("solid tag variable declarations", () => {
  const counter = {
    template: {
      filename: "/fixtures/tags/counter.mx",
      source: "<span>${input.start}</span>\n<return value=input.start + 1/>",
    },
  } as unknown as CustomTag;
  const PAIR =
    "<div/el/><section><span/el/><button onClick() { el() }/></section>";

  /**
   * The mappings whose source starts and ends inside `[start, end)`, as
   * `[sourceStart, generated text, use]`.
   */
  function inside(
    { code, mappings }: { code: string; mappings: readonly Mapping[] },
    [start, end]: readonly [number, number],
  ): unknown[][] {
    return mappings
      .filter((m) => m.sourceStart >= start && m.sourceEnd <= end)
      .map((m) => [
        m.sourceStart,
        code.slice(m.generatedStart, m.generatedEnd),
        m.use,
      ]);
  }
  type Mapping = ReturnType<typeof compileSolidUnit>["mappings"][number];
  const USE = { navigation: true, semantic: true };

  // Each row: the source, the `[start, end)` of one authored `/var`, the
  // mappings expected from inside that range as `[sourceStart, generated
  // text]`, and the declaration as the emit writes it (unchanged by the
  // mapping).
  it.each([
    ["an element reference", "<div/el/>", [5, 7], [[5, "el"]], "let el: any;"],
    [
      "a literal dynamic tag's element reference",
      '<${"my-el"}/el/>',
      [12, 14],
      [[12, "el"]],
      "let el: any;",
    ],
    [
      "a call's /var",
      "<counter/n start=1/>",
      [9, 10],
      [[9, "n"]],
      "let n: any;",
    ],
    [
      "a /var in a lazy body",
      "<for|i| of=[1]><counter/n start=i/>${n}</for>",
      [24, 25],
      [[24, "n"]],
      "(() => { let n: any; return <>",
    ],
    [
      "the outer /var of a renamed pair",
      PAIR,
      [5, 7],
      [[5, "el"]],
      "let el: any, __mxVar0_el: any;",
    ],
    [
      "the inner, renamed /var of a pair as a whole",
      PAIR,
      [24, 26],
      [[24, "__mxVar0_el"]],
      "let el: any, __mxVar0_el: any;",
    ],
  ] as const)(
    "maps %s at the authored name in a unit",
    (_name, source, range, expected, declaration) => {
      const result = compileSolidUnit(source, {
        filename: "/fixtures/page.mx",
        customTags: { counter },
      });
      expect(inside(result, range)).toEqual(
        expected.map(([at, name]) => [at, name, USE]),
      );
      expect(result.code).toContain(declaration);
    },
  );

  it.each([
    [
      "an element reference",
      "<div/el/><button onClick() { el() }/>",
      [5, 7],
      [[5, "el"]],
      "{(() => { let el: any; return <>",
    ],
    [
      "a returning <define> call's /var",
      "<define/Twice><return=1/></define><Twice/v/><p>${v}</p>",
      [41, 42],
      [[41, "v"]],
      "{(() => { let v: any; return <>",
    ],
  ] as const)(
    "maps %s at the authored name in a region",
    (_name, source, range, expected, declaration) => {
      const result = compileSolidMx(source, {
        filename: "/fixtures/view.solid.mx",
      });
      expect(inside(result, range)).toEqual(
        expected.map(([at, name]) => [at, name, USE]),
      );
      expect(result.code).toContain(declaration);
    },
  );
});
