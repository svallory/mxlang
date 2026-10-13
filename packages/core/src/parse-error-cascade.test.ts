/**
 * An expression error in an open tag is the cause of the tag-level error it
 * triggers, and it is reported first. `<for of=[1]|x|>` reads `|>` as the
 * pipeline operator, which swallows the tag's `>`: the expression error is at
 * the `|>`, and the "Missing ending tag" error at the tag's `<` is its
 * cascade. Stock Marko reports both, the expression error first.
 *
 * Also the spans of two parse errors that used to be zero-width: an
 * expression error covers the offending token, and a trigger line's "ends
 * after its text" error covers the stray text.
 *
 * Every case runs under the default table and under a non-default one (the
 * member module), through `parseFragment`, `compileSource` and `lowerSource`.
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { MEMBER } from "./fixtures/syntax/member-fixture.ts";
import { parseFragment } from "./fragment.ts";
import { type IrDiagnostic, lowerSource } from "./ir-entry/index.ts";
import { defaultSyntax, type SyntaxTable } from "./syntax-table.ts";
import { lookup as targets } from "./test-targets.ts";

const FILE = "/virtual/page.mx";

const MEMBER_TABLE: SyntaxTable = Object.freeze({
  ...defaultSyntax(),
  expressionTriggers: [MEMBER],
  attributeTriggers: [MEMBER],
  lineTriggers: [MEMBER],
});

const TABLES: [name: string, table: SyntaxTable | undefined][] = [
  ["the default table", undefined],
  ["the member module's table", MEMBER_TABLE],
];

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

type Located = Error & {
  diagnosticCode?: string;
  errors?: Located[];
  loc: {
    start: { line: number; column: number; index: number };
    end: { line: number; column: number; index: number };
  };
};

function thrown(run: () => unknown): Located {
  try {
    run();
  } catch (error) {
    return error as Located;
  }
  throw new Error("expected an error");
}

const viaFragment = (source: string, table?: SyntaxTable) =>
  thrown(() =>
    parseFragment(source, {
      filename: FILE,
      targets,
      ...(table ? { dialect: table } : {}),
    }),
  );

const viaCompile = (source: string, table?: SyntaxTable) =>
  thrown(() =>
    compileSource(source, FILE, declarations, {
      targets,
      emitIr: () => "ok",
      ...(table ? { dialect: table } : {}),
    }),
  );

/** The errors a caller sees, in order: an aggregate's, or the one thrown. */
const listOf = (error: Located): Located[] => error.errors ?? [error];

/** `code line:column-line:column` of each error, in order. */
const thrownRanges = (error: Located): string[] =>
  listOf(error).map(
    (e) =>
      `${e.diagnosticCode} ${e.loc.start.line}:${e.loc.start.column}-${e.loc.end.line}:${e.loc.end.column}`,
  );

const diagnosticsOf = (source: string, table?: SyntaxTable): IrDiagnostic[] =>
  lowerSource(source, FILE, table ? { dialect: table } : {}).diagnostics;

/** `code line:column-line:column` of each diagnostic, in order. */
const diagnosticRanges = (diagnostics: IrDiagnostic[]): string[] =>
  diagnostics.map(
    (d) => `${d.code} ${d.line}:${d.column}-${d.end?.line}:${d.end?.column}`,
  );

describe.each(TABLES)(
  "an expression error that causes a missing end tag, under %s",
  (_n, table) => {
    const SOURCE = "<for of=[1]|x|>\n</for>";
    // `|>` is columns 13-14: the error is at the `|`, and spans both characters.
    const CAUSE = "MX_PARSE_EXPRESSION 1:13-1:15";
    // The swallowed tag: from its `<` to the end of what it swallowed.
    const CASCADE = "MX_PARSE_MISSING_END_TAG 1:0-2:6";

    it("parseFragment lists the cause first", () => {
      expect(thrownRanges(viaFragment(SOURCE, table))).toEqual([
        CAUSE,
        CASCADE,
      ]);
    });

    it("compileSource lists the cause first", () => {
      expect(thrownRanges(viaCompile(SOURCE, table))).toEqual([CAUSE, CASCADE]);
    });

    it("lowerSource lists the cause first", () => {
      expect(diagnosticRanges(diagnosticsOf(SOURCE, table))).toEqual([
        CAUSE,
        CASCADE,
      ]);
    });

    it.each([
      [
        "<if=input.x :b>y\n",
        "MX_EXPECTED_SINGLE_EXPRESSION 1:12-1:13",
        "MX_PARSE_MISSING_END_TAG 1:0-1:15",
      ],
      [
        "<div x=1 :b>\n",
        "MX_EXPECTED_SINGLE_EXPRESSION 1:9-1:10",
        "MX_PARSE_MISSING_END_TAG 1:0-1:12",
      ],
    ])(
      "a second expression in the open tag is the cause too, in the same order for every caller: %s",
      (source, cause, cascade) => {
        expect(thrownRanges(viaFragment(source, table))).toEqual([
          cause,
          cascade,
        ]);
        expect(thrownRanges(viaCompile(source, table))).toEqual([
          cause,
          cascade,
        ]);
        expect(diagnosticRanges(diagnosticsOf(source, table))).toEqual([
          cause,
          cascade,
        ]);
      },
    );

    it("lowerSource keeps the cause first when the tag is nested", () => {
      expect(
        diagnosticRanges(
          diagnosticsOf("<div>\n  <for of=[1]|x|>\n</div>", table),
        ),
      ).toEqual([
        "MX_PARSE_EXPRESSION 2:15-2:17",
        "MX_PARSE_MISSING_END_TAG 2:2-3:6",
      ]);
    });

    it("lowerSource leaves an earlier unrelated expression error where it is", () => {
      expect(
        diagnosticRanges(
          diagnosticsOf("<div x=(1+)/>\n<for of=[1]|x|>\n</for>", table),
        ),
      ).toEqual([
        "MX_PARSE_EXPRESSION 1:10-1:11",
        "MX_PARSE_EXPRESSION 2:13-2:15",
        "MX_PARSE_MISSING_END_TAG 2:0-3:6",
      ]);
    });

    it("lowerSource puts an expression error in the open tag of a tag that is never closed first, as Marko does", () => {
      expect(diagnosticRanges(diagnosticsOf("<div x=(1+)>\n", table))).toEqual([
        "MX_PARSE_EXPRESSION 1:10-1:11",
        "MX_PARSE_MISSING_END_TAG 1:0-1:12",
      ]);
    });

    it("lowerSource does not move an expression error past the open tag of the unclosed tag", () => {
      // The error is in the body of `<div>`, not in its open tag.
      expect(
        diagnosticRanges(diagnosticsOf("<div>\n<span x=(1+)/>\n", table)),
      ).toEqual([
        "MX_PARSE_MISSING_END_TAG 1:0-1:5",
        "MX_PARSE_EXPRESSION 2:11-2:12",
      ]);
    });

    it("lowerSource keeps position order for a missing end tag whose open tag has no expression error", () => {
      const diagnostics = diagnosticsOf("<div>\n<for of=[1]>\n", table);
      expect(diagnostics.map((d) => d.code)[0]).toBe(
        "MX_PARSE_MISSING_END_TAG",
      );
    });
  },
);

describe.each(TABLES)(
  "an expression error spans its token, under %s",
  (_n, table) => {
    // [source, code, token line:column-line:column]
    const CASES: [name: string, source: string, range: string][] = [
      [
        "a punctuator after an operand",
        "<div x=(1+)/>",
        "MX_PARSE_EXPRESSION 1:10-1:11",
      ],
      [
        "a two-character operator",
        "<div x=(a |> b)/>",
        "MX_PARSE_EXPRESSION 1:10-1:12",
      ],
      ["an identifier", "<div x=(a bcd)/>", "MX_PARSE_EXPRESSION 1:10-1:13"],
      ["a string", '<div x=(a "str")/>', "MX_PARSE_EXPRESSION 1:10-1:15"],
      ["a number", "<div x=(a 12.5)/>", "MX_PARSE_EXPRESSION 1:10-1:14"],
      // The expression stopped at a delimiter outside its container: the
      // error is on that character.
      [
        "a placeholder's closing brace",
        "${1+}\n",
        "MX_PARSE_EXPRESSION 1:4-1:5",
      ],
      [
        "a tag argument's closing paren",
        "<if(x.)>\n</if>",
        "MX_PARSE_EXPRESSION 1:6-1:7",
      ],
      [
        "an attribute value's closing angle",
        "<div x=a.>\n</div>",
        "MX_PARSE_EXPRESSION 1:9-1:10",
      ],
      [
        "a regular expression's flags",
        "<div x=/re/x/>",
        "MX_PARSE_EXPRESSION 1:12-1:13",
      ],
    ];
    it.each(CASES)("compileSource: %s", (_c, source, range) => {
      expect(thrownRanges(viaCompile(source, table))[0]).toBe(range);
    });
    it.each(CASES)("lowerSource: %s", (_c, source, range) => {
      expect(diagnosticRanges(diagnosticsOf(source, table))[0]).toBe(range);
    });
    it.each(CASES)(
      "the CompileError's loc has no zero-width end: %s",
      (_c, source) => {
        const [error] = listOf(viaCompile(source, table));
        expect(error?.loc.end.index).toBeGreaterThan(
          error?.loc.start.index ?? 0,
        );
      },
    );
  },
);

describe("a trigger line that ends after its text spans the stray text", () => {
  const CODE = "MX_PARSE_INVALID_CHARACTER";
  const CASES: [name: string, source: string, range: string][] = [
    ["one word", "div\n  &title foo", `${CODE} 2:9-2:12`],
    ["several words", "div\n  &title foo bar baz", `${CODE} 2:9-2:20`],
    [
      "trailing whitespace is not stray text",
      "div\n  &title foo  \n",
      `${CODE} 2:9-2:12`,
    ],
    [
      "a carriage return is not stray text",
      "div\r\n  &title foo\r\n",
      `${CODE} 2:9-2:12`,
    ],
    ["after a value", "div\n  &a=1 2 3", `${CODE} 2:7-2:10`],
  ];
  it.each(CASES)("compileSource: %s", (_c, source, range) => {
    expect(thrownRanges(viaCompile(source, MEMBER_TABLE))).toEqual([range]);
  });
  it.each(CASES)("parseFragment: %s", (_c, source, range) => {
    expect(thrownRanges(viaFragment(source, MEMBER_TABLE))).toEqual([range]);
  });
  it.each(CASES)("lowerSource: %s", (_c, source, range) => {
    expect(diagnosticRanges(diagnosticsOf(source, MEMBER_TABLE))).toEqual([
      range,
    ]);
  });
  it("the default table has no trigger line to end early", () => {
    expect(() =>
      compileSource("div\n  &title foo", FILE, declarations, {
        targets,
        emitIr: () => "ok",
      }),
    ).not.toThrow(/ends after its text/);
  });
});
