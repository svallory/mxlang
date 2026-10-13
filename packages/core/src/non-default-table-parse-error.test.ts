/**
 * A parse error under a non-default syntax table has the shape it has under
 * the default row: the `CompileError` the parser's error becomes
 * (`compileErrorOf`), with its `loc`, `filename`, `label`, code frame and MX
 * code, positioned in the file. It used to be a bare `TranslateError`
 * (line/column/file, no `loc`) for every table but the default row.
 *
 * Each case parses the same source under the default row and under a
 * non-default table and compares the two error objects field by field, then
 * pins the numbers, so the comparison cannot pass on two equally wrong
 * errors. A table-caused error that is not a parse error ("has no lowering
 * yet") keeps its own shape, and the first error in the file wins, whichever
 * kind it is (a parse error, a front-end rule error, an expression error, or
 * the table's).
 */
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { isTranslateError } from "./core.ts";
import { MEMBER } from "./fixtures/syntax/member-fixture.ts";
import { parseFragment } from "./fragment.ts";
import {
  defaultSyntax,
  type SyntaxTable,
  type Trigger,
} from "./syntax-table.ts";
import { lookup as targets } from "./test-targets.ts";

const FILE = "/virtual/page.mx";

/** The member module's table (the fixture the sugar tests use), with no hooks. */
const MEMBER_TABLE: SyntaxTable = Object.freeze({
  ...defaultSyntax(),
  expressionTriggers: [MEMBER],
  attributeTriggers: [MEMBER],
  lineTriggers: [MEMBER],
});

/**
 * A table that ends an attribute value at a spaced `:name`, so that
 * `x=(a) :T => a` (one value in the default row) is an attribute `x` with no
 * value followed by an attribute row.
 */
const COLON_NAME: Trigger = {
  id: "colon-name",
  chars: ":",
  match: ":[A-Za-z_$][\\w$]*",
  standIn: "keep",
  node: "attribute",
  terminatesValue: true,
};
const COLON_TABLE: SyntaxTable = Object.freeze({
  ...defaultSyntax(),
  attributeTriggers: [COLON_NAME],
});

const declarations = {
  tags: {},
  isElement: () => true,
  isComponent: () => false,
};

type Base = {
  baseOffset?: number;
  baseLine?: number;
  baseColumn?: number;
};

function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected an error");
}

const viaFragment = (source: string, table?: SyntaxTable, base: Base = {}) =>
  thrown(() =>
    parseFragment(source, {
      filename: FILE,
      targets,
      ...base,
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

/** Every own property, enumerable or not, by name: the whole error object. */
function fields(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { constructor: error.constructor.name };
  for (const name of Object.getOwnPropertyNames(error)) {
    const value = (error as unknown as Record<string, unknown>)[name];
    if (typeof value !== "function") out[name] = value;
  }
  return out;
}

const locOf = (error: Error) =>
  (error as Error & { loc: { start: object; end: object } }).loc;

/** Sources that fail to parse in every table: one error, at a known place. */
const BROKEN: [name: string, source: string, message: string, code: string][] =
  [
    [
      "an open tag the file ends in",
      "<div>\n  <span x=1\n",
      "EOF reached while parsing open tag",
      "MX_PARSE_MALFORMED_OPEN_TAG",
    ],
    [
      "a closing tag that does not match",
      "<div>\n</span>",
      'The closing "span" tag does not match the corresponding opening "div" tag',
      "MX_PARSE_MISMATCHED_CLOSING_TAG",
    ],
  ];

describe.each([
  ["member module", MEMBER_TABLE],
  ["colon-name table", COLON_TABLE],
])("a parse error under the %s", (_, table) => {
  describe.each([
    ["parseFragment", viaFragment],
    ["compileSource", viaCompile],
  ])("through %s", (_via, run) => {
    it.each(BROKEN)(
      "%s: the whole error object is the default row's",
      (_n, source) => {
        const def = run(source);
        const error = run(source, table);
        expect(fields(error)).toEqual(fields(def));
        expect(error.name).toBe("CompileError");
        expect(isTranslateError(error)).toBe(false);
      },
    );

    it.each(BROKEN)(
      "%s: carries its loc, code and text",
      (_n, source, message, code) => {
        const error = run(source, table) as Error & {
          label: string;
          diagnosticCode: string;
          filename: string;
        };
        expect(locOf(error)).toBeDefined();
        // `compileSource` appends the position to the label (`hintParseError`).
        expect(error.label.startsWith(message)).toBe(true);
        expect(error.diagnosticCode).toBe(code);
        expect(error.filename).toBe(FILE);
        expect(error.message).toContain(message);
      },
    );
  });

  it("is positioned where the default row puts it (loc.start/end, 1-based line, 0-based column, UTF-16 index)", () => {
    const error = viaFragment("<div>\n  <span x=1\n", table);
    expect(locOf(error)).toEqual({
      start: { line: 2, column: 2, index: 8 },
      end: { line: 2, column: 2, index: 8 },
    });
    // A range error: the closing tag.
    expect(locOf(viaFragment("<div>\n</span>", table))).toEqual({
      start: { line: 2, column: 0, index: 6 },
      end: { line: 2, column: 7, index: 13 },
    });
  });

  it("counts a surrogate pair as two columns, as the default row does", () => {
    const source = "<p>\u{1F600}</span>";
    expect(fields(viaFragment(source, table))).toEqual(
      fields(viaFragment(source)),
    );
    expect(locOf(viaFragment(source, table)).start).toEqual({
      line: 1,
      column: 5,
      index: 5,
    });
  });

  describe("a region fragment", () => {
    // The fragment sits at line 5, column 10, offset 40 of its file.
    const base: Base = { baseOffset: 40, baseLine: 4, baseColumn: 10 };

    it("is file-relative on the fragment's first line (base applied once)", () => {
      const source = "<div x=(/>";
      const def = viaFragment(source, undefined, base);
      const error = viaFragment(source, table, base);
      expect(fields(error)).toEqual(fields(def));
      const { start } = locOf(error) as { start: Record<string, number> };
      // Fragment-local 1:8 / index 8 becomes 5:18 / index 48: shifted once.
      expect(start).toEqual({ line: 5, column: 18, index: 48 });
    });

    it("is file-relative on a later line (the column is not shifted)", () => {
      const source = "<div>\n  <span x=1\n";
      const def = viaFragment(source, undefined, base);
      const error = viaFragment(source, table, base);
      expect(fields(error)).toEqual(fields(def));
      expect(locOf(error)).toEqual({
        start: { line: 6, column: 2, index: 48 },
        end: { line: 6, column: 2, index: 48 },
      });
    });

    it("a range error shifts its start and end once each", () => {
      const error = viaFragment("<div>\n</span>", table, base);
      expect(locOf(error)).toEqual({
        start: { line: 6, column: 0, index: 46 },
        end: { line: 6, column: 7, index: 53 },
      });
    });
  });
});

describe("`x=(a) :T => a` under a table that ends a value at a spaced `:name`", () => {
  const source = "<div x=(a) :T => a/>";

  it("is one value in the default row", () => {
    expect(() => viaFragment(source)).toThrow("expected an error");
    expect(() => viaCompile(source)).toThrow("expected an error");
  });

  it("is a positioned parse error in the table's row, with its loc", () => {
    for (const run of [viaFragment, viaCompile]) {
      const error = run(source, COLON_TABLE) as Error & {
        label: string;
        diagnosticCode: string;
      };
      expect(error.name).toBe("CompileError");
      expect(error.label).toBe("Missing value for attribute");
      expect(error.diagnosticCode).toBe("MX_PARSE_INVALID_ATTRIBUTE_VALUE");
      expect(locOf(error)).toEqual({
        start: { line: 1, column: 15, index: 15 },
        end: { line: 1, column: 15, index: 15 },
      });
    }
  });

  it("is file-relative in a region, shifted once", () => {
    const error = viaFragment(source, COLON_TABLE, {
      baseOffset: 40,
      baseLine: 4,
      baseColumn: 10,
    });
    expect(locOf(error)).toEqual({
      start: { line: 5, column: 25, index: 55 },
      end: { line: 5, column: 25, index: 55 },
    });
  });
});

describe("an error the table causes that is not a parse error keeps its shape", () => {
  // `&status` is a `{ call }` trigger the table has no hook to lower.
  it("is still a positioned TranslateError", () => {
    for (const run of [viaFragment, viaCompile]) {
      const error = run("x=() => &status\n", MEMBER_TABLE);
      expect(isTranslateError(error)).toBe(true);
      expect(error.message).toBe("`member` trigger has no lowering yet");
      expect(error).toMatchObject({ line: 1, column: 8, file: FILE });
    }
  });

  it("the first error in the file wins, whichever kind it is", () => {
    // The unlowerable trigger comes first: its error.
    const trigger = viaFragment(
      "x=() => &status\n<div>\n</span>",
      MEMBER_TABLE,
    );
    expect(trigger.message).toBe("`member` trigger has no lowering yet");
    // The parse error comes first: the default row's parse error.
    const parse = viaFragment(
      "<div>\n</span>\nx=() => &status\n",
      MEMBER_TABLE,
    );
    expect(parse.name).toBe("CompileError");
    expect(locOf(parse).start).toEqual({ line: 2, column: 0, index: 6 });
  });

  // Errors the parser reports that are not template parse errors: a front-end
  // rule error and a shorthand error (both ways), an expression error (a
  // compile only: a fragment keeps expression errors in the tree).
  const TRIGGER = "x=() => &status\n";
  const NO_LOWERING = "`member` trigger has no lowering yet";
  describe.each([
    {
      name: "a shorthand that repeats an id",
      error: '<div#a id="b"/>\n',
      code: "MX_INVALID_SHORTHAND",
      at: { line: 1, column: 7, index: 7 },
      runs: [viaFragment, viaCompile],
    },
    {
      name: "an attribute tag at the root",
      error: "<@a/>\n",
      code: "MX_ATTRIBUTE_TAG_AT_ROOT",
      at: { line: 1, column: 1, index: 1 },
      runs: [viaFragment, viaCompile],
    },
    {
      name: "an expression error",
      error: "<div x=(1+)/>\n",
      code: "MX_PARSE_EXPRESSION",
      at: { line: 1, column: 10, index: 10 },
      runs: [viaCompile],
    },
  ])("$name", ({ error, code, at, runs }) => {
    it.each(runs.map((run) => [run.name, run] as const))(
      "comes first: its error, not the trigger's (%s)",
      (_n, run) => {
        const thrownError = run(error + TRIGGER, MEMBER_TABLE) as Error & {
          diagnosticCode: string;
        };
        expect(thrownError.name).toBe("CompileError");
        expect(thrownError.diagnosticCode).toBe(code);
        expect(locOf(thrownError).start).toEqual(at);
      },
    );

    it.each(runs.map((run) => [run.name, run] as const))(
      "comes after the trigger: the trigger's error (%s)",
      (_n, run) => {
        const thrownError = run(TRIGGER + error, MEMBER_TABLE);
        expect(isTranslateError(thrownError)).toBe(true);
        expect(thrownError.message).toBe(NO_LOWERING);
        expect(thrownError).toMatchObject({ line: 1, column: 8, file: FILE });
      },
    );
  });

  it.each([
    ["parseFragment", viaFragment],
    ["compileSource", viaCompile],
  ])(
    "a template error first, with the trigger in the tree: its error (%s)",
    (_n, run) => {
      // The open tag never closes, and the parser goes on to the trigger.
      const error = run("<div>\nx=() => &status\n", MEMBER_TABLE) as Error & {
        diagnosticCode: string;
      };
      expect(error.name).toBe("CompileError");
      expect(error.diagnosticCode).toBe("MX_PARSE_MISSING_END_TAG");
      expect(locOf(error).start).toEqual({ line: 1, column: 0, index: 0 });
    },
  );

  it("a region fragment compares in the fragment's own offsets, base aside", () => {
    const base: Base = { baseOffset: 40, baseLine: 4, baseColumn: 10 };
    const first = viaFragment(
      `<div#a id="b"/>\n${TRIGGER}`,
      MEMBER_TABLE,
      base,
    );
    expect(first.name).toBe("CompileError");
    expect(locOf(first).start).toEqual({ line: 5, column: 17, index: 47 });
    const later = viaFragment(
      `${TRIGGER}<div#a id="b"/>\n`,
      MEMBER_TABLE,
      base,
    );
    expect(later.message).toBe(NO_LOWERING);
  });
});
