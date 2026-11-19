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

  it("maps a <for>'s row and index binders", () => {
    // The binder `i` maps as well as its read (before: only the read).
    expect(pairs("<for|r, i| of=xs><p>${i}</p></for>")).toEqual([
      ["xs", "xs"],
      ["r", "r"],
      ["i", "i"],
      ["i", "i"],
    ]);
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
      "a call's destructured /var",
      "<counter/{ a, b: c } start=1/>",
      [9, 20],
      [
        [11, "a"],
        [17, "c"],
      ],
      "let a: any, c: any;",
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

/**
 * A region `<define>` is hoisted to module scope through the string-only
 * `hoistedDefines` channel, so its mappings ride on each entry: the name onto
 * the gensym (hover only), each param as a declaration, and the body and
 * `<return>` as Solid recorded them. The emitted text is unchanged.
 */
describe("solid hoisted define mappings", () => {
  const USE = { navigation: true, semantic: true };
  type Entry = ReturnType<typeof compileSolidMx>["hoistedDefines"][number];
  /** Each mapping as `[sourceStart, generated text, use]`. */
  const rows = (entry: Entry | undefined) =>
    (entry?.mappings ?? []).map((m) => [
      m.sourceStart,
      entry?.code.slice(m.generatedStart, m.generatedEnd),
      m.use,
    ]);

  it("maps a define's name, params, body /var and reads", () => {
    const result = compileSolidMx(
      "<ul><define/Row|n|><div/el/><button onClick() { el().focus() }>${n}</button></define><Row(1)/></ul>",
      { filename: "/fixtures/view.solid.mx" },
    );
    expect(result.code).toBe("<ul>{__mx_DefineRow1(1)}</ul>");
    expect(result.hoistedDefines.map((entry) => entry.code)).toEqual([
      "function __mx_DefineRow1(n) { return (() => { let el: any; return <><><div ref={(__mxNode: Element) => { el = () => __mxNode; }}></div><button onClick={function () { el().focus(); }}>{n}</button></></>; })(); }",
    ]);
    expect(rows(result.hoistedDefines[0])).toEqual([
      [12, "__mx_DefineRow1", { semantic: true }],
      [16, "n", USE],
      [24, "el", USE],
      [46, "{ el().focus()", undefined],
      [60, " }", undefined],
      [65, "n", undefined],
    ]);
  });

  it("puts a returning define's body on the pair and its name on the binding", () => {
    const result = compileSolidMx(
      "<ul><define/Twice|n|><return=n * 2/>${n}</define><Twice(1)/v/></ul>",
      { filename: "/fixtures/view.solid.mx" },
    );
    expect(result.code).toBe(
      "{(() => { let v: any; return <><ul><__mx_DefineTwice3 a={[1]} v={(__mxV) => { v = __mxV; }} /></ul></>; })()}",
    );
    expect(result.hoistedDefines.map((entry) => entry.code)).toEqual([
      "function __mx_DefineTwice2(n) { return { value: (n * 2), output: <>{() => { const __mxText0 = n; const __mxEscaped0 = __mxEscape(__mxText0); return __mxEscaped0 === undefined ? __mxText0 : __mxEscaped0; }}</> }; }",
      "function __mx_DefineTwice1(...a: Parameters<typeof __mx_DefineTwice2>) { return __mx_DefineTwice2(...a).output; }",
      'function __mx_DefineTwice3(p: { a: Parameters<typeof __mx_DefineTwice2>; v: (value: ReturnType<typeof __mx_DefineTwice2>["value"]) => void }) { const r = __mx_DefineTwice2(...p.a); p.v(r.value); return r.output; }',
    ]);
    const [pair, binding, varCall] = result.hoistedDefines;
    expect(rows(pair)).toEqual([
      [18, "n", USE],
      [29, "n * 2", undefined],
      [38, "n", undefined],
    ]);
    expect(rows(binding)).toEqual([
      [12, "__mx_DefineTwice1", { semantic: true }],
    ]);
    expect(varCall && "mappings" in varCall).toBe(false);
  });

  // A binder Solid writes as a plain string (a `<for>`'s params, a call's
  // content params, a `<@catch>`'s params) maps onto its authored text as a
  // declaration; the emitted code is what it was before the mapping.
  it("maps a <for of>'s row and index in a define body as declarations", () => {
    const result = compileSolidMx(
      "<ul><define/Row|xs|><for|r, i| of=xs><p>${r}${i}</p></for></define><Row([1])/></ul>",
      { filename: "/fixtures/view.solid.mx" },
    );
    expect(result.code).toBe("<ul>{__mx_DefineRow1([1])}</ul>");
    expect(result.hoistedDefines.map((entry) => entry.code)).toEqual([
      "function __mx_DefineRow1(xs) { return <For each={xs}>{(r, i) => <p>{r}{i()}</p>}</For>; }",
    ]);
    expect(rows(result.hoistedDefines[0])).toEqual([
      [12, "__mx_DefineRow1", { semantic: true }],
      [16, "xs", USE],
      [34, "xs", undefined],
      [25, "r", USE],
      [28, "i", USE],
      [42, "r", undefined],
      [46, "i", undefined],
    ]);
  });

  it("maps a range <for>'s param in a define body as a declaration", () => {
    const result = compileSolidMx(
      "<ul><define/Row><for|n| from=0 to=2><p>${n}</p></for></define><Row/></ul>",
      { filename: "/fixtures/view.solid.mx" },
    );
    expect(result.code).toBe("<ul>{__mx_DefineRow1()}</ul>");
    expect(result.hoistedDefines.map((entry) => entry.code)).toEqual([
      "function __mx_DefineRow1() { return <Repeat count={3} from={0}>{(n) => <p>{n}</p>}</Repeat>; }",
    ]);
    expect(rows(result.hoistedDefines[0])).toEqual([
      [12, "__mx_DefineRow1", { semantic: true }],
      [21, "n", USE],
      [41, "n", undefined],
    ]);
  });

  it("maps a call's content params in a define body as declarations", () => {
    const result = compileSolidMx(
      "<ul><define/Box|input|>${input.content(1)}</define><define/Row><Box|v|>${v}</Box></define><Row/></ul>",
      { filename: "/fixtures/view.solid.mx" },
    );
    expect(result.code).toBe("<ul>{__mx_DefineRow1()}</ul>");
    expect(result.hoistedDefines.map((entry) => entry.code)).toEqual([
      "function __mx_DefineBox1(input) { return <>{() => { const __mxText0 = input.content(1); const __mxEscaped0 = __mxEscape(__mxText0); return __mxEscaped0 === undefined ? __mxText0 : __mxEscaped0; }}</>; }",
      "function __mx_DefineRow1() { return <>{__mx_DefineBox1({ content: (v) => <>{() => { const __mxText1 = v; const __mxEscaped1 = __mxEscape(__mxText1); return __mxEscaped1 === undefined ? __mxText1 : __mxEscaped1; }}</> })}</>; }",
    ]);
    expect(rows(result.hoistedDefines[1])).toEqual([
      [59, "__mx_DefineRow1", { semantic: true }],
      [64, "__mx_DefineBox1", undefined],
      [68, "v", USE],
      [73, "v", undefined],
    ]);
  });

  it("maps a <@catch>'s params in a define body as declarations", () => {
    const result = compileSolidMx(
      "<ul><define/Row><try><p>x</p><@catch|err|>${err.message}</@catch></try></define><Row/></ul>",
      { filename: "/fixtures/view.solid.mx" },
    );
    expect(result.code).toBe("<ul>{__mx_DefineRow1()}</ul>");
    expect(result.hoistedDefines.map((entry) => entry.code)).toEqual([
      "function __mx_DefineRow1() { return <Errored fallback={(__mxErr, ...__mxArgs) => ((err) => <>{() => { const __mxText0 = err.message; const __mxEscaped0 = __mxEscape(__mxText0); return __mxEscaped0 === undefined ? __mxText0 : __mxEscaped0; }}</>)(__mxErr(), ...__mxArgs)}><Loading><p>x</p></Loading></Errored>; }",
    ]);
    expect(rows(result.hoistedDefines[0])).toEqual([
      [12, "__mx_DefineRow1", { semantic: true }],
      [37, "err", USE],
      [44, "err.message", undefined],
    ]);
  });

  it("maps an attribute tag's params in a define body as declarations", () => {
    const result = compileSolidMx(
      "<ul><define/Box|input|>x</define><define/Row><Box><@item|v|>${v}</@item></Box></define><Row/></ul>",
      { filename: "/fixtures/view.solid.mx" },
    );
    expect(result.code).toBe("<ul>{__mx_DefineRow1()}</ul>");
    // Index 0 is the attribute-tag runtime the region hoists.
    expect(rows(result.hoistedDefines[2])).toEqual([
      [41, "__mx_DefineRow1", { semantic: true }],
      [46, "__mx_DefineBox1", undefined],
      [52, "{", undefined],
      [57, "v", USE],
      [62, "v", undefined],
      [52, "}", undefined],
    ]);
  });

  // An attribute tag directly in the region: Solid records its binder on the
  // region's own mappings, as it does in a define body.
  const regionRows = (result: ReturnType<typeof compileSolidMx>) =>
    result.mappings.map((m) => [
      m.sourceStart,
      result.code.slice(m.generatedStart, m.generatedEnd),
      m.use,
    ]);

  it("maps an attribute tag's params as declarations", () => {
    const source =
      "<ul><define/Box|input|>x</define><Box><@item|v|>${v}</@item></Box></ul>";
    const result = compileSolidMx(source, {
      filename: "/fixtures/view.solid.mx",
    });
    expect(result.code).toBe(
      '<ul>{__mx_DefineBox1({ "item": __mxAttrTag({ content: ((v) => () => <>{() => { const __mxText0 = v; const __mxEscaped0 = __mxEscape(__mxText0); return __mxEscaped0 === undefined ? __mxText0 : __mxEscaped0; }}</>) as (...args: any[]) => any }) })}</ul>',
    );
    expect(regionRows(result)).toEqual([
      [34, "__mx_DefineBox1", undefined],
      [40, "{", undefined],
      [45, "v", USE],
      [50, "v", undefined],
      [40, "}", undefined],
    ]);
  });

  it("maps an attribute-tag <for>'s param as a declaration", () => {
    const source =
      "<ul><define/Box|input|>x</define><Box><for|i| of=xs><@item>${i}</@item></for></Box></ul>";
    const result = compileSolidMx(source, {
      filename: "/fixtures/view.solid.mx",
    });
    expect(result.code).toBe(
      '<ul>{__mx_DefineBox1({ "item": (() => { let __mxAttrTagAcc; for (const i of ((__mxList1) => __mxList1 ? [...__mxList1] : [])(xs)) { __mxAttrTagAcc = __mxAttrTags(__mxAttrTagAcc, { content: () => <>{() => { const __mxText0 = i; const __mxEscaped0 = __mxEscape(__mxText0); return __mxEscaped0 === undefined ? __mxText0 : __mxEscaped0; }}</> }); } return __mxAttrTagAcc; })() })}</ul>',
    );
    expect(regionRows(result)).toEqual([
      [34, "__mx_DefineBox1", undefined],
      [43, "i", USE],
      [54, "{", undefined],
      [61, "i", undefined],
      [54, "}", undefined],
    ]);
  });
});
