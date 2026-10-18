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
  `\`${text}\` (the \`${id}\` trigger) cannot be written in a \`${keyword}\` statement: the trigger lowers inside an expression of the template, and a module statement runs outside it. Move it into a \`<const>\` or write it in the template`;

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
  const hit = (text: string) => {
    const found = firstRowIn(text, rows);
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
    expect(hit("f(x)\n~zz")).toBeUndefined();
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

  it("no rows, no hit", () => {
    expect(firstRowIn("~zz", [])).toBeUndefined();
  });
});
