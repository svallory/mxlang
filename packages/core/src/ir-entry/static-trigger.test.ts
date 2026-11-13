/**
 * A dialect expression row written in a module statement (`static`) is a
 * positioned error at the row's first character: the parser announces no
 * trigger in module code, so the row used to reach the module as the
 * JavaScript it looks like (`~zz` is a bitwise NOT) with no diagnostic
 * (spec §13.9.9). Through the atom fixture (sigil `~`, valid JavaScript) and
 * the member fixture (sigil `&`, which Babel refuses), and a row table of
 * the test's own for the matching rules.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { firstRowIn } from "../static-triggers.ts";
import type { Dialect, Trigger } from "../syntax-table.ts";
import { lowerSource } from "./index.ts";

const load = (path: string): Dialect =>
  (createRequire(import.meta.url)(path) as { default: Dialect }).default;
const atom = load("../fixtures/syntax/atom-fixture.ts");
const member = load("../fixtures/syntax/member-fixture.ts");

function lowered(source: string, dialect?: Dialect) {
  const result = lowerSource(source, "/v/entity.mx", { dialect });
  const hoisted = (result.ir?.hoisted ?? []) as { code: string }[];
  return {
    diagnostics: result.diagnostics,
    code: hoisted.map((each) => each.code),
  };
}

const MESSAGE = (text: string, id: string, keyword = "static") =>
  `\`${text}\` (the \`${id}\` trigger) cannot be written in ${keyword === "export" ? "an" : "a"} \`${keyword}\` statement: the trigger lowers inside an expression of the template, and a module statement runs outside it. Move it into a \`<const>\` or write it in the template`;

describe("a dialect expression row in a static statement", () => {
  const cases: [string, string, number, number, string][] = [
    ["static const", "static const z = ~zz;\n<div/>", 1, 17, "~zz"],
    ["static let", "static let z = ~zz;\n<div/>", 1, 15, "~zz"],
    [
      "inside a function",
      "static function f() { return ~zz; }\n<div/>",
      1,
      29,
      "~zz",
    ],
    [
      "nested in an array and an object",
      "static const z = [1, { a: ~zz }];\n<div/>",
      1,
      26,
      "~zz",
    ],
    ["parenthesised", "static const z = (~zz);\n<div/>", 1, 18, "~zz"],
    ["in a static block", "static { const z = ~zz; }\n<div/>", 1, 19, "~zz"],
    [
      "on a later line of a block",
      "static {\n  const a = 1;\n  const z = ~zz;\n}\n<div/>",
      3,
      12,
      "~zz",
    ],
    [
      "in a template literal substitution",
      "static const z = `a${~zz}`;\n<div/>",
      1,
      21,
      "~zz",
    ],
    ["after a block's `}`", "static { f(x) } ~zz\n<div/>", 1, 16, "~zz"],
    [
      "after a line break that ends a statement",
      "static {\n  f(x)\n  ~zz\n}\n<div/>",
      3,
      2,
      "~zz",
    ],
  ];

  it.each(cases)(
    "%s (atom): refused at the row",
    (_, source, line, col, text) => {
      const { diagnostics, code } = lowered(source, atom);
      expect(code).toEqual([]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "MX_INVALID_TRIGGER_USE",
        message: MESSAGE(text, "atom-node"),
        line,
        column: col,
      });
    },
  );

  it.each([
    ["server", "server const z = ~zz;\n<div/>", 17],
    ["client", "client const z = ~zz;\n<div/>", 17],
    ["export", "export const z = ~zz;\n<div/>", 17],
    ["export", "export function f() { return ~zz; }\n<div/>", 29],
  ])("a `%s` statement is refused too", (keyword, source, col) => {
    const { diagnostics, code } = lowered(source, atom);
    expect(code).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MX_INVALID_TRIGGER_USE",
      message: MESSAGE("~zz", "atom-node", keyword),
      line: 1,
      column: col,
    });
  });

  it.each([
    ["server", "server {\n  f(x)\n  ~zz\n}\n<div/>"],
    ["export", "export function f() {\n  g()\n  ~zz\n}\n<div/>"],
  ])(
    "a row at a statement start in a `%s` statement is refused",
    (keyword, source) => {
      const { diagnostics, code } = lowered(source, atom);
      expect(code).toEqual([]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "MX_INVALID_TRIGGER_USE",
        message: MESSAGE("~zz", "atom-node", keyword),
        line: 3,
        column: 2,
      });
    },
  );

  it('under `structural: "reject"` the structural error stands alone', () => {
    const run = (source: string) =>
      lowerSource(source, "/v/entity.mx", {
        dialect: member,
        structural: "reject",
      }).diagnostics.map((each) => each.code);
    expect(run("static const z = 1 &zz;\n<div/>")).toEqual([
      "MX_STRUCTURAL_CONSTRUCT",
    ]);
    // Babel refuses `&zz` first, as it did before: never the row error.
    expect(run("static const z = &zz;\n<div/>")).not.toContain(
      "MX_INVALID_TRIGGER_USE",
    );
  });

  it("the member row (`&`, not JavaScript there) gives the row's error, not Babel's", () => {
    const { diagnostics } = lowered("static const z = &zz;\n<div/>", member);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "MX_INVALID_TRIGGER_USE",
      message: MESSAGE("&zz", "member"),
      line: 1,
      column: 17,
    });
  });

  it("the first row in the statement is the one reported", () => {
    const { diagnostics } = lowered(
      "static const z = [~aa, ~bb];\n<div/>",
      atom,
    );
    expect(diagnostics[0]?.column).toBe(18);
    expect(diagnostics[0]?.message).toBe(MESSAGE("~aa", "atom-node"));
  });

  describe("the row's node type is asked to claim it", () => {
    const tok: Trigger = Object.freeze({
      id: "tok",
      chars: "~",
      match: "~[a-z]+",
      standIn: "identifier",
      node: Object.freeze({ type: "Tok", dialect: "claims" }),
    });
    const claims = {
      id: "claims",
      name: "Claims",
      table: Object.freeze({
        expressionTriggers: [tok],
        attributeTriggers: [],
      }),
      nodeTypes: {
        Tok: {
          keys: [],
          schema: { fields: { name: "data" }, slot: ["expression"] },
          parse: (
            text: string,
            _span: unknown,
            ctx: { fail(message: string, options?: object): never },
          ) =>
            text === "~skip"
              ? undefined
              : text === "~boom"
                ? ctx.fail("no boom here", { code: "CLAIMS_BOOM" })
                : { name: text.slice(1) },
          print: (node: { name: string }) => `~${node.name}`,
          lower: (
            node: { name: string },
            ctx: { expression(node: object): unknown },
          ) =>
            ctx.expression({
              type: "StringLiteral",
              value: node.name,
              extra: { raw: JSON.stringify(node.name), rawValue: node.name },
            }),
        },
      },
    } as unknown as Dialect;

    it("a declined row is plain source", () => {
      expect(lowered("static const z = ~skip;\n<div/>", claims)).toEqual({
        diagnostics: [],
        code: ["const z = ~skip;"],
      });
    });

    it("a claimed row is refused", () => {
      const { diagnostics } = lowered("static const z = ~ok;\n<div/>", claims);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "MX_INVALID_TRIGGER_USE",
        message: MESSAGE("~ok", "tok"),
        line: 1,
        column: 17,
      });
    });

    it("a claim's `ctx.fail` is the dialect's error at the row", () => {
      const { diagnostics } = lowered(
        "static const z = ~boom;\n<div/>",
        claims,
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "CLAIMS_BOOM",
        message: "no boom here",
        line: 1,
        column: 17,
      });
    });

    it("a row in a comment or a string runs no `parse`", () => {
      const { diagnostics } = lowered(
        "static const z = '~boom'; // ~boom\n<div/>",
        claims,
      );
      expect(diagnostics).toEqual([]);
    });
  });

  it("the same row in a `<const>` still lowers", () => {
    const { diagnostics } = lowered("<const/z=~zz/>\n<div/>", atom);
    expect(diagnostics).toEqual([]);
  });
});

describe("what stays byte-identical", () => {
  it("a file with no dialect keeps `~zz` as JavaScript", () => {
    expect(lowered("static const z = ~zz;\n<div/>")).toEqual({
      diagnostics: [],
      code: ["const z = ~zz;"],
    });
  });

  it("a dialect whose marks do not appear in the static", () => {
    const source = "static const z = (1 & 2) + 3;\n<div/>";
    expect(lowered(source, member)).toEqual({
      diagnostics: [],
      code: ["const z = (1 & 2) + 3;"],
    });
    expect(lowered("static const z = 1;\n<div/>", atom).code).toEqual([
      "const z = 1;",
    ]);
  });

  it("a mark in a comment, a string or a template text is no row", () => {
    for (const body of [
      "const z = 1; // ~zz",
      "const z = 1; /* ~zz */",
      'const z = "~zz";',
      "const z = '~zz';",
      "const z = `~zz`;",
      "const z = `a${1}~zz`;",
      "const z = /~zz/;",
    ]) {
      const { diagnostics, code } = lowered(`static ${body}\n<div/>`, atom);
      expect(diagnostics).toEqual([]);
      expect(code).toEqual([body]);
    }
  });

  it("`server`, `client` and `export` without a row keep their text", () => {
    for (const keyword of ["server", "client", "export"]) {
      const body = "const z = 1 + 2;";
      expect(lowered(`${keyword} ${body}\n<div/>`, atom).diagnostics).toEqual(
        [],
      );
    }
    expect(lowered("export const z = ~zz;\n<div/>").diagnostics).toEqual([]);
  });

  it("`export static` keeps the parser's error", () => {
    const { diagnostics } = lowered(
      "export static const z = ~zz;\n<div/>",
      atom,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      message: 'Unexpected token, expected "{"',
      line: 1,
      column: 7,
    });
    expect(diagnostics[0]?.code).not.toBe("MX_INVALID_TRIGGER_USE");
  });
});

describe("the matching is the template scanner's", () => {
  const row = (id: string, chars: string, match: string): Trigger =>
    ({
      id,
      chars,
      match,
      standIn: "identifier",
      node: { type: "Atom", dialect: "atom" },
    }) as Trigger;
  const sigil = row("sigil", "~", "~[a-z]+");
  const mark = row("mark", "%", "%\\.[a-z]+");
  const set = row("set", "@#", "[@#][a-z]+");
  const member = row("member", "&", "&[a-z]+");
  const rows = [sigil, mark, set, member];
  const hit = (text: string, kit: readonly Trigger[] = rows) => {
    const found = firstRowIn(text, kit, "static");
    return found && [found.row.id, text.slice(found.start, found.end)];
  };

  it("a first character arms one row; its match decides", () => {
    expect(hit("a = ~zz")).toEqual(["sigil", "~zz"]);
    expect(hit("a = ~1")).toBeUndefined();
    expect(hit("a = ~(x)")).toBeUndefined();
  });

  it("a literal mark matches in full", () => {
    expect(hit("a = %.name")).toEqual(["mark", "%.name"]);
    expect(hit("a = %name")).toBeUndefined();
    expect(hit("a = % .name")).toBeUndefined();
  });

  it("a chars set is compared by the first character", () => {
    expect(hit("a = @one")).toEqual(["set", "@one"]);
    expect(hit("a = #two")).toEqual(["set", "#two"]);
    expect(hit("a = $two")).toBeUndefined();
  });

  it("never inside a word, after the same character, or where no operand stands", () => {
    expect(hit("a~zz")).toBeUndefined();
    expect(hit("a ~~zz")).toBeUndefined();
    expect(hit("f(x)\n~zz")).toEqual(["sigil", "~zz"]);
    expect(hit("a[0] ~zz")).toBeUndefined();
    expect(hit("return ~zz")).toEqual(["sigil", "~zz"]);
    expect(hit("f(a, ~zz)")).toEqual(["sigil", "~zz"]);
  });

  it("comments, strings and template-literal text are skipped; a substitution is code", () => {
    expect(hit("// ~zz\n")).toBeUndefined();
    expect(hit("/* ~zz */")).toBeUndefined();
    expect(hit("\"~zz\" + '~zz'")).toBeUndefined();
    expect(hit("`~zz`")).toBeUndefined();
    expect(hit("`${a}~zz`")).toBeUndefined();
    expect(hit("`x${~zz}`")).toEqual(["sigil", "~zz"]);
    expect(hit('"a\\"~zz"')).toBeUndefined();
    expect(hit("/~zz/.test(x)")).toBeUndefined();
    expect(hit("a / ~zz")).toEqual(["sigil", "~zz"]);
  });

  it("valid JavaScript and TypeScript the template reads as no row", () => {
    const kit = [row("atom", ":", ":[a-z]+"), row("member", "&", "&[a-z]+")];
    for (const code of [
      "const m = i++ &mask;",
      "const m = i-- &mask;",
      "const m = x! &y;",
      "type T = Array<X> &Y;",
      "const m = /a/ &b;",
      "function f(a?:string) {}",
      "let x!:number;",
      "class A { p?:string; q!:number }",
      "const z = c ? x! :y;",
      "const z = c ? i++ :y;",
      "const o = { key:value };",
    ]) {
      expect([code, firstRowIn(code, kit)?.row.id]).toEqual([code, undefined]);
    }
  });

  it("a row after a spread, an operator or a statement head is found", () => {
    expect(hit("[...~zz]")).toEqual(["sigil", "~zz"]);
    expect(hit("if (a) ~zz;")).toEqual(["sigil", "~zz"]);
    expect(hit("a ? ~zz : 1")).toEqual(["sigil", "~zz"]);
    expect(hit("x = i + ~zz")).toEqual(["sigil", "~zz"]);
    expect(hit("typeof ~zz")).toEqual(["sigil", "~zz"]);
    expect(hit("if (x) /~zz/.test(s)")).toBeUndefined();
    expect(hit("a = ~zzé")).toBeUndefined();
  });

  describe("a row at a statement start is found", () => {
    it.each([
      ["{ f(x) } ~zz", ["sigil", "~zz"]],
      ["{\n f(x)\n ~zz\n}", ["sigil", "~zz"]],
      ["f(x) /*\n*/ ~zz", ["sigil", "~zz"]],
      ["if (a) { b } ~zz", ["sigil", "~zz"]],
      ["for await (const x of xs) { f(x) } ~zz", ["sigil", "~zz"]],
      ["switch (a) { case 1: case 2: { b } ~zz }", ["sigil", "~zz"]],
      ["switch (a) { case 1:\n default: { b } ~zz }", ["sigil", "~zz"]],
      ["switch (a) { case b: c: { d } ~zz }", ["sigil", "~zz"]],
      ["f = () => { lbl: { b } ~zz }", ["sigil", "~zz"]],
      ["function f(): [number, string] { return g() } ~zz", ["sigil", "~zz"]],
      ["function f(): Map<a, b> { } ~zz", ["sigil", "~zz"]],
      ['const a = { class: "b" }\nif (x) {\n f()\n ~zz\n}', ["sigil", "~zz"]],
      ["o.x = { class: 1 }\nif (x) { @zz }", ["set", "@zz"]],
      ["x = c ? g(\n y\n) : {} / 2; z = ~zz", ["sigil", "~zz"]],
      [
        "switch (a) { case 1: let t: [number?] = []; break\n case 2: { b } ~zz }",
        ["sigil", "~zz"],
      ],
    ])("%j", (text, expected) => {
      expect(hit(text)).toEqual(expected);
    });
  });

  describe("a row Babel reads only as its stand-in is found", () => {
    it.each([
      ["const a = @zz\nclass B {}", ["set", "@zz"]],
      ["switch (a) { case 1: x = @zz\n default: y() }", ["set", "@zz"]],
      ["class A {\n m(a = f(@zz)) {}\n}", ["set", "@zz"]],
      ["class A { x = f(@zz) }", ["set", "@zz"]],
      ["class A { x = [1, @zz] }", ["set", "@zz"]],
      ["#zz\nclass B {}", ["set", "#zz"]],
      ["x = { @zz }", ["set", "@zz"]],
      // A decorator on its own line: its stand-in parses (ASI), so it is a row.
      ["@dec\nclass B {}", ["set", "@dec"]],
    ])("%j", (text, expected) => {
      expect(hit(text)).toEqual(expected);
    });
  });

  describe("an assignment's target is a row", () => {
    it.each([
      ["f(x)\n~zz = 1", ["sigil", "~zz"]],
      ["&zz += 1", ["member", "&zz"]],
      ["[&a, &b] = xs", ["member", "&a"]],
      ["({ &zz } = o)", ["member", "&zz"]],
    ])("%j", (text, expected) => {
      expect(hit(text)).toEqual(expected);
    });
    // Controls: the same patterns in a declaration bind, so no row.
    it.each(["const { @zz } = o", "const [&a] = xs"])("%j", (text) => {
      expect(hit(text)).toBeUndefined();
    });
  });

  describe("of several rows, the first decided as a row is reported", () => {
    it.each([
      ["const a = ~aa, b = &bb", ["sigil", "~aa"]],
      ["const a = &aa, b = &bb", ["member", "&aa"]],
      ["const m = a\n  &mask; const k = &kk", ["member", "&kk"]],
    ])("%j", (text, expected) => {
      expect(hit(text)).toEqual(expected);
    });
  });

  describe("a class member is no row", () => {
    it.each([
      "class A {\n x = 1\n @dec y = 2\n}",
      "class A {\n m() {}\n @dec y = 2\n}",
      "class A {\n constructor() {}\n #b = 2\n}",
      "class A { static {} #b = 2 }",
      "class A {\n  #b = 2\n}",
      "class A {\n x = 1;\n #b = 2;\n}",
      "class A {\n  @dec\n  m() {}\n}",
      "class A {\n constructor(@inject b) {}\n}",
      "class A {\n x = 1\n constructor(@inject b) {}\n}",
      "class A {\n x: number\n m(@a b) {}\n}",
      "abstract class A {\n abstract m(): void\n #b = 1\n}",
      "class A {\n x: void\n #b = 1\n}",
      "class A<T extends {}> {\n x = 1\n @dec y = 2\n}",
      "class A extends (b < c ? X : Y) {\n x = 1\n @dec y = 2\n}",
      "class A { #x; m() { if (#x in this) {} } }",
    ])("%j", (text) => {
      expect(hit(text)).toBeUndefined();
    });
  });

  describe("a decorator is no row", () => {
    it.each([
      "class A {}\n@dec class B {}",
      "x = y\n@a.b class B {}",
      "x = y\n@a (1) class B {}",
      "@dec<Map<a, () => b>>() class B {}",
    ])("%j", (text) => {
      expect(hit(text)).toBeUndefined();
    });
  });

  describe("after an object literal, not a block, there is no row", () => {
    it.each([
      "x = { a: [b, f(c)] }\ny = { q: 1 } ~zz",
      "const f = function (): { a: 1 } { } ~zz",
      "x = c ? (1) : { b } ~zz",
      "a = c ? [\n 1\n] : { b } ~zz",
    ])("%j", (text) => {
      expect(hit(text)).toBeUndefined();
    });
  });

  describe("a mark in a type is no row", () => {
    it.each([
      "let t: { a: 1 } &zz = v",
      "function f(a: { b: 1 } &zz) {}",
      "interface I { a: { b: 1 } &zz }",
      "class A { default() { let t: { a: 1 } &zz = v } }",
      "x = { default() { let t: { a: 1 } &zz = v } }",
      "function f<T>(x: T): x is { a: 1 } &zz {}",
      "let x: @zz = 1",
    ])("%j", (text) => {
      expect(hit(text)).toBeUndefined();
    });
  });

  describe("after a declaration header there is no row", () => {
    it.each([
      "function f(a: string): string\nexport default { a } &zz",
      "declare function f(): void\nexport default { a } &zz",
      "const namespace = ns\nconst g = () => { return { a: 1 } &zz }",
    ])("%j", (text) => {
      expect(hit(text)).toBeUndefined();
    });
  });

  describe("the JavaScript reading wins", () => {
    it.each([
      ["a\n&mask", rows],
      ["x = a\n  -zz", [row("minus", "-", "-[a-z]+")]],
    ] as const)("%j", (text, kit) => {
      expect(hit(text, kit)).toBeUndefined();
    });
  });

  describe("a name a declaration binds is no row", () => {
    const dollar = [row("dollar", "$", "\\$[a-z]+")];
    it.each([
      "interface $zz {}",
      "type $zz = 1",
      "enum $zz { A }",
      // A pin on Babel: `isReferenced` reads an enum member's name as no
      // reference by itself.
      "enum E { $zz }",
      "declare function $zz(): void",
      "namespace $zz {}",
      "interface I { $zz(): void }",
      "class A { $zz(): void; $zz() {} }",
      "class A { constructor(private $zz: number) {} }",
      "declare function f($zz: number): void",
      "function f($zz: string): void\nfunction f(a: any) {}",
      "interface I { m($zz: number): void }",
      "interface I { [$zz: string]: number }",
      "interface I { ($zz: number): void }",
      "interface I { new ($zz: number): I }",
      "class A { m($zz: number): void; m() {} }",
      "abstract class A { abstract m($zz: number): void }",
      "class A { [$zz: string]: number }",
      "import $zz = require('x')",
      "import $zz = N.B",
      "export import $zz = N.x",
      "export as namespace $zz",
    ])("%j", (text) => {
      expect(hit(text, dollar)).toBeUndefined();
    });
    // Controls: a TypeScript parent's expression, an enum initializer and a
    // computed key are references.
    it.each([
      ["enum E { A = $zz }", ["dollar", "$zz"]],
      ["let a = $zz as T", ["dollar", "$zz"]],
      ["interface I { [$zz]: number }", ["dollar", "$zz"]],
      ["class A { [$zz](): void }", ["dollar", "$zz"]],
    ])("%j is a row", (text, expected) => {
      expect(hit(text, dollar)).toEqual(expected);
    });
  });

  it("a key is no row, whatever its stand-in", () => {
    const tilde = [
      { ...row("num", "~", "~[a-z]+"), standIn: "number" } as Trigger,
    ];
    expect(hit("x = { ~zz: 1 }", tilde)).toBeUndefined();
    expect(hit("class A { ~zz() {} }", tilde)).toBeUndefined();
  });

  it("a match holding another row's first character is one stand-in", () => {
    const kit = [row("path", "#", "#[\\w/~]+"), sigil];
    // An overlong variant would move the block's closing brace.
    expect(hit("{ y = ~yy; x = #a/~b }", kit)).toEqual(["sigil", "~yy"]);
  });

  it("no rows, no hit", () => {
    expect(firstRowIn("~zz", [])).toBeUndefined();
  });

  it("a match the matcher stops short of non-ASCII is no row", () => {
    const tail = [row("tail", "~", "~[a-z]+(?:-\\w+)*")];
    expect(hit("a = ~a-é", tail)).toBeUndefined();
    expect(hit("a = ~a-b", tail)).toEqual(["tail", "~a-b"]);
    expect(hit("a = ~ab", tail)).toEqual(["tail", "~ab"]);
    const kept = [
      { ...row("kept", "~", "~[a-z]+(?:-\\w+)*"), standIn: "keep" },
    ];
    expect(hit("a = ~a-é", kept as Trigger[])).toEqual(["kept", "~a"]);
  });

  describe("the row's node type claims the text", () => {
    const asked: string[] = [];
    const claimed = (text: string, kit: readonly Trigger[] = rows) => {
      asked.length = 0;
      const found = firstRowIn(text, kit, "static", (each) => {
        const written = text.slice(each.start, each.end);
        asked.push(written);
        return !written.endsWith("skip");
      });
      return found && [found.row.id, text.slice(found.start, found.end)];
    };

    it("a claimed row is found", () => {
      expect(claimed("a = ~ok")).toEqual(["sigil", "~ok"]);
      expect(asked).toEqual(["~ok"]);
    });

    it("a declined row is no row", () => {
      expect(claimed("a = ~skip")).toBeUndefined();
      expect(asked).toEqual(["~skip"]);
    });

    it("the first declined, the next is decided and asked once each", () => {
      expect(claimed("a = [~skip, ~ok]")).toEqual(["sigil", "~ok"]);
      expect(asked).toEqual(["~skip", "~ok"]);
      expect(claimed("a = [&skip, &ok]")).toBeUndefined();
      expect(asked).toEqual(["&skip"]);
      expect(claimed("a = [~skip, &ok]")).toEqual(["member", "&ok"]);
      expect(asked).toEqual(["~skip", "&ok"]);
    });

    it("a mark in a comment, a string or template text is never asked", () => {
      expect(claimed("a = 1; // ~zz")).toBeUndefined();
      expect(claimed("a = '~zz' + `~yy` + /* ~xx */ 1")).toBeUndefined();
      expect(claimed("a = '&zz' + `&yy`; b = ~ok")).toEqual(["sigil", "~ok"]);
      expect(asked).toEqual(["~ok"]);
    });
  });
});
