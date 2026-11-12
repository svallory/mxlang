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
      "static {\n f(x)\n ~zz\n}\n<div/>",
      3,
      1,
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
  const rows = [sigil, mark, set];
  const hash = row("hash", "#", "#[a-z]+");
  const at = row("at", "@", "@[a-z]+");
  const hit = (text: string, using: Trigger[] = rows) => {
    const found = firstRowIn(text, using);
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
    expect(hit("f(x)\n&zz")).toBeUndefined();
    expect(hit("a[0] ~zz")).toBeUndefined();
    expect(hit("return ~zz")).toEqual(["sigil", "~zz"]);
    expect(hit("f(a, ~zz)")).toEqual(["sigil", "~zz"]);
  });

  type Row = [string, [string, string] | undefined, Trigger[]?];
  const table = (name: string, cases: Row[]) =>
    it.each(cases)(`${name}: %j`, (text, expected, using) => {
      expect(hit(text, using)).toEqual(expected);
    });
  const ZZ: [string, string] = ["sigil", "~zz"];

  describe("a statement start after a block's `}` or an inserted semicolon", () => {
    table("is found", [
      ["if (a) { b } ~zz", ZZ],
      ["a = 1\n~zz", ZZ],
      ["i++\n~zz", ZZ],
      ["a = /x/\n~zz", ZZ],
      ["f(x) /*\n*/ ~zz", ZZ],
      ["function f(): void { } ~zz", ZZ],
      ["switch (a) { case 1: { b } ~zz }", ZZ],
      ["a: { b } ~zz", ZZ],
      ["export function f() { } ~zz", ZZ],
      ["class A { m() { f(x)\n ~zz } }", ZZ],
      ["const f = function () {} / 2 / ~zz", ZZ],
      ["for await (const x of xs) { f(x) } ~zz", ZZ],
      ["switch (a) { case 1: case 2: { b } ~zz }", ZZ],
      ["switch (a) { case 1:\n default: { b } ~zz }", ZZ],
      ["switch (a) { case b: c: { d } ~zz }", ZZ],
      ["f = () => { lbl: { b } ~zz }", ZZ],
      [
        "switch (a) { case 1: let t: [number?] = []; break\n case 2: { b } ~zz }",
        ZZ,
      ],
    ]);
    table("is an operand end, no start", [
      ["const f = function () {} ~zz", undefined],
      ["a = class {} ~zz", undefined],
      ["export default { a: 1 } ~zz", undefined],
      ["x = y as { a: 1 } ~zz", undefined],
      ["f = () => { a } ~zz", undefined],
      ["a = c ? 1 : { b } ~zz", undefined],
      ["x = c ? (1) : { b } ~zz", undefined],
      ["a = { k: { b } } ~zz", undefined],
      ["a = { b } ~zz", undefined],
      ["a = f({ b }) ~zz", undefined],
      ["a = { b }\n&zz", undefined],
      ["a.\n~zz", undefined],
    ]);
  });

  describe("a type literal is no block", () => {
    const amp = row("amp", "&", "&[a-z]+");
    table("in a type position", [
      ["let t: { a: 1 } &zz = v", undefined, [amp]],
      ["function f(a: { b: 1 } &zz) {}", undefined, [amp]],
      ["interface I { a: { b: 1 } &zz }", undefined, [amp]],
      ["class A { default() { let t: { a: 1 } &zz = v } }", undefined, [amp]],
      ["function f(x): x is { a: 1 } &zz {}", undefined, [amp]],
      ["const f = function (): { a: 1 } { } ~zz", undefined],
      ["class A<T extends {}> {\n x = 1\n @dec y = 2\n}", undefined, [at]],
      [
        "class X implements B<{ a: 1 }> {\n x = 1\n @dec y = 2\n}",
        undefined,
        [at],
      ],
    ]);
  });

  describe("`class` as a property key opens no class body", () => {
    table("found", [
      ['const a = { class: "b" }\nif (x) {\n f()\n ~zz\n}', ZZ],
      ["o.x = { class: 1 }\nif (x) { @zz }", ["at", "@zz"], [at]],
    ]);
  });

  describe("a comma in a header's tuple or generic does not end the header", () => {
    table("is found", [
      ["function f(): [number, string] { return g() } ~zz", ZZ],
      ["function f(): Map<a, b> { } ~zz", ZZ],
    ]);
    table("no row", [
      [
        "class A extends (b < c ? X : Y) {\n x = 1\n @dec y = 2\n}",
        undefined,
        [at],
      ],
    ]);
  });

  describe("a ternary survives a line break inside brackets", () => {
    table("ternary", [
      ["x = c ? g(\n y\n) : {} / 2; z = ~zz", ZZ],
      ["a = c ? [\n 1\n] : { b } ~zz", undefined],
    ]);
  });

  describe("a method head is a key of its own brace", () => {
    table("a call after a comma is no method", [
      ["x = { a: [b, f(c)] }\ny = { q: 1 } ~zz", undefined],
    ]);
  });

  describe("a class body's members are no statements", () => {
    table("no row", [
      ["class A {\n x = 1\n ~zz y = 2\n}", undefined],
      ["class A {\n x = 1\n #b = 2\n}", undefined, [hash]],
      ["class A {\n x = 1\n @dec y = 2\n}", undefined, [at]],
      ["class A {\n m() {}\n @dec y = 2\n}", undefined, [at]],
      ["class A { static {} #b = 2 }", undefined, [hash]],
      ["class A {\n constructor() {}\n #b = 2\n}", undefined, [hash]],
      ["class A {\n  #b = 2\n}", undefined, [hash]],
      ["class A {\n x = 1;\n #b = 2;\n}", undefined, [hash]],
      ["class A {\n  @dec\n  m() {}\n}", undefined, [at]],
      ["class A {\n constructor(@inject b) {}\n}", undefined, [at]],
      ["class A {\n x = 1\n constructor(@inject b) {}\n}", undefined, [at]],
      ["class A {\n x: number\n m(@a b) {}\n}", undefined, [at]],
      ["class A {\n abstract m(): void\n #b = 1\n}", undefined, [hash]],
      ["class A {\n x: void\n #b = 1\n}", undefined, [hash]],
    ]);
  });

  describe("a row in a class field initializer is a row", () => {
    table("found", [
      ["class A { x = f(@b) }", ["at", "@b"], [at]],
      ["class A { x = [1, @b] }", ["at", "@b"], [at]],
    ]);
  });

  describe("a decorator before a declaration is TypeScript", () => {
    table("no row", [
      ["class A {}\n@dec class B {}", undefined, [at]],
      ["class A {}\n@dec(1) @other export class B {}", undefined, [at]],
      ["x = y\n@a.b class B {}", undefined, [at]],
      ["x = y\n@a<T>() class B {}", undefined, [at]],
      ["x = y\n@a (1) class B {}", undefined, [at]],
    ]);
    table("in an operand position it is a row", [
      ["const a = @zz\nclass B {}", ["at", "@zz"], [at]],
      ["class A {\n m(a = f(@zz)) {}\n}", ["at", "@zz"], [at]],
    ]);
    table("a row after a class", [["class A {} @dec", ["at", "@dec"], [at]]]);
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

  it("no rows, no hit", () => {
    expect(firstRowIn("~zz", [])).toBeUndefined();
  });
});
