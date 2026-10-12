/**
 * `IrDiagnostic.end`: where a diagnostic's range ends, exclusive, in the same
 * file as its start, through `lowerSource`.
 *
 * One test per kind of thing an error blames: a whole tag (ends at the end of
 * `<name`, never at the element's close), a tag name, an attribute, an
 * expression across lines, a text run, a parse error with a range and one at a
 * point, a keyword, and a file-level error that has no range. Then the two
 * conditions a consumer that copies the fields relies on: `end.offset` is
 * never `-1` for a diagnostic in the lowered file, and is `-1` exactly when
 * `file` names another file, as for the start's `offset`.
 */
import { describe, expect, it } from "vitest";
import type { MxWarning } from "../core.ts";
import type { CustomTag } from "../custom-tags.ts";
import type {
  Dialect,
  UnknownTag,
  UnknownTagExplanation,
} from "../syntax-table.ts";
import {
  type IrDiagnostic,
  lineStartsOf,
  toDiagnostic,
} from "./diagnostics.ts";
import { type LowerSourceOptions, lowerSource } from "./index.ts";

/** `[line, column, offset]` of a diagnostic's start and of its end. */
function range(d: IrDiagnostic | undefined) {
  return {
    start: [d?.line, d?.column, d?.offset],
    end: d?.end && [d.end.line, d.end.column, d.end.offset],
  };
}

/** The one diagnostic `source` reports. */
function only(source: string, options: LowerSourceOptions = {}) {
  const { diagnostics } = lowerSource(source, "/t.mx", options);
  expect(diagnostics).toHaveLength(1);
  return diagnostics[0] as IrDiagnostic;
}

describe("a whole-tag error ends at the end of `<name`", () => {
  it("an unknown tag, not at its closing tag", () => {
    const { diagnostics } = lowerSource(
      "<div>\n  <foo>\n    x\n  </foo>\n</div>\n",
      "/t.mx",
      { unknownTags: "reject" },
    );
    expect(diagnostics.map((d) => [d.code, range(d)])).toEqual([
      ["MX_UNKNOWN_TAG", { start: [1, 0, 0], end: [1, 4, 4] }],
      ["MX_UNKNOWN_TAG", { start: [2, 2, 8], end: [2, 6, 12] }],
    ]);
  });

  it("a tag the lowering refuses (`<for>` with no `of=`)", () => {
    expect(range(only("<for|x|/>\n"))).toEqual({
      start: [1, 0, 0],
      end: [1, 4, 4],
    });
  });

  it("a tag whose body is long still ends at its name", () => {
    expect(range(only("<if>\n  a\n  b\n</if>\n"))).toEqual({
      start: [1, 0, 0],
      end: [1, 3, 3],
    });
  });

  it("a tag variable on a data tag", () => {
    expect(range(only("<div/x/>\n", { structural: "reject" })).end).toEqual([
      1, 4, 4,
    ]);
  });

  it("a name no data file can use", () => {
    expect(range(only("<$x/>\n"))).toEqual({
      start: [1, 0, 0],
      end: [1, 3, 3],
    });
  });

  it("a call of a refused `customTags` name", () => {
    const { diagnostics } = lowerSource("<if/>\n", "/t.mx", {
      customTags: { if: {} },
    });
    const reserved = diagnostics.find((d) => d.code === "MX_RESERVED_TAG");
    expect(range(reserved)).toEqual({ start: [1, 0, 0], end: [1, 3, 3] });
  });
});

describe("a tag name ends at the name", () => {
  it("the name of a `<const>` that takes more than `value=`", () => {
    expect(range(only("<const/x=1 y=2/>\n"))).toEqual({
      start: [1, 1, 1],
      end: [1, 6, 6],
    });
  });
});

describe("an attribute ends after its value", () => {
  it("an attribute name core refuses", () => {
    expect(range(only("<div @a=1/>\n"))).toEqual({
      start: [1, 5, 5],
      end: [1, 9, 9],
    });
  });
});

describe("an expression ends at its last character", () => {
  it("one on a single line", () => {
    expect(range(only("<div x:=1+2/>\n"))).toEqual({
      start: [1, 8, 8],
      end: [1, 11, 11],
    });
  });

  it("one across lines: the end is on a later line", () => {
    expect(range(only("<div\n  x:=\n    (1 +\n 2)\n/>\n"))).toEqual({
      start: [3, 5, 16],
      end: [4, 2, 22],
    });
  });

  it("an interpolation, braces included", () => {
    expect(range(only("<div>${x}</div>\n", { structural: "reject" }))).toEqual({
      start: [1, 5, 5],
      end: [1, 9, 9],
    });
  });
});

describe("a text run ends at its text", () => {
  it("a structural reject of text, past its leading layout", () => {
    expect(
      range(only("<div>\n  hello\n</div>\n", { structural: "reject" })),
    ).toEqual({ start: [2, 2, 8], end: [2, 7, 13] });
  });
});

describe("a structural reject ends at the keyword", () => {
  it.each([
    ["<if=x>hi</if>\n", [1, 0, 0], [1, 3, 3]],
    ["<for|x| of=y>\n  <b/>\n</for>\n", [1, 0, 0], [1, 4, 4]],
    ["<const/x=1/>\n", [1, 0, 0], [1, 6, 6]],
    ["import x from 'y'\n<div/>\n", [1, 0, 0], [1, 6, 6]],
    ["<!doctype html>\n<div/>\n", [1, 0, 0], [1, 9, 9]],
  ])("%j", (source, start, end) => {
    const { diagnostics } = lowerSource(source, "/t.mx", {
      structural: "reject",
    });
    expect(diagnostics.map((d) => range(d))).toEqual([{ start, end }]);
  });
});

describe("a parse error carries the parser's range", () => {
  it("a range: the close tag that does not match", () => {
    expect(range(only("<div></span>\n"))).toEqual({
      start: [1, 5, 5],
      end: [1, 12, 12],
    });
  });

  it("a range across lines", () => {
    expect(range(only("<div>\n  <p>\n</div>\n"))).toEqual({
      start: [3, 0, 12],
      end: [3, 6, 18],
    });
  });

  it("a point: the end equals the start", () => {
    expect(range(only("<div x=(1 +)/>\n"))).toEqual({
      start: [1, 11, 11],
      end: [1, 11, 11],
    });
  });

  it("a point at the end of the input", () => {
    expect(range(only("<div"))).toEqual({
      start: [1, 0, 0],
      end: [1, 0, 0],
    });
  });

  it("a second expression keeps its code and ends at its point", () => {
    const d = only("${a b}\n");
    expect(d.code).toBe("MX_EXPECTED_SINGLE_EXPRESSION");
    expect(range(d)).toEqual({ start: [1, 4, 4], end: [1, 4, 4] });
  });

  it("the front end's own rule: an `<@name>` at the root", () => {
    expect(range(only("<@foo/>\n"))).toEqual({
      start: [1, 1, 1],
      end: [1, 5, 5],
    });
  });

  it("the front end's own rule: a bare `,` line is the `,`", () => {
    expect(range(only(",\n"))).toEqual({
      start: [1, 0, 0],
      end: [1, 1, 1],
    });
  });
});

describe("a file-level error has no end", () => {
  it("a registration error at 1:0", () => {
    const d = only("<pub/>\n<other/>\n", {
      customTags: { pub: { finalize: () => [] } },
    });
    expect(d.end).toBeUndefined();
    expect(Object.keys(d)).not.toContain("end");
    expect([d.line, d.column, d.offset]).toEqual([1, 0, 0]);
  });

  it("a warning at line 0, even when the sink entry names an end", () => {
    const warnings: MxWarning[] = [];
    const { diagnostics } = lowerSource("<pub/>\n", "/t.mx", {
      warnings,
      customTags: {
        pub: {
          transform() {
            warnings.push({
              message: "probe",
              line: 0,
              column: 0,
              end: { line: 1, column: 3 },
            });
            return [];
          },
        },
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.end).toBeUndefined();
  });

  it("a warning from a sink keeps the end it was given", () => {
    const warnings: MxWarning[] = [];
    const { diagnostics } = lowerSource("<pub/>\n", "/t.mx", {
      warnings,
      customTags: {
        pub: {
          transform() {
            warnings.push({
              message: "probe",
              line: 1,
              column: 1,
              end: { line: 1, column: 4 },
            });
            return [];
          },
        },
      },
    });
    expect(range(diagnostics[0])).toEqual({
      start: [1, 1, 1],
      end: [1, 4, 4],
    });
  });
});

describe("a dialect's explanation of an unknown tag", () => {
  /** Explains every tag, by the hook's own rule. */
  function dialectOf(
    explain: (tag: UnknownTag) => UnknownTagExplanation | undefined,
  ): Dialect {
    return {
      id: "fixture",
      name: "Fixture",
      table: {},
      explainUnknownTag: explain,
    };
  }
  const run = (
    source: string,
    explain: (tag: UnknownTag) => UnknownTagExplanation | undefined,
  ) =>
    lowerSource(source, "/f.mx", {
      dialect: dialectOf(explain),
      tagRules: "none",
      unknownTags: "reject",
    }).diagnostics;

  it("a returned `at` span is the range", () => {
    const d = run("<a/>\n<b>\n  x\n</b>\n", (tag) =>
      tag.name === "b"
        ? { message: "no b", at: { sourceStart: 6, sourceEnd: 12 } }
        : undefined,
    ).find((each) => each.message === "no b");
    expect(range(d)).toEqual({ start: [2, 1, 6], end: [3, 3, 12] });
  });

  it("without `at`, the error is on the tag: its `<name`", () => {
    const [d] = run("<b>\n  x\n</b>\n", () => ({ message: "no b" }));
    expect(range(d)).toEqual({ start: [1, 0, 0], end: [1, 2, 2] });
  });

  it("a hook that throws is on the tag too", () => {
    const [d] = run("<b/>\n", () => {
      throw new Error("boom");
    });
    expect(d?.code).toBe("MX_DIALECT_HOOK_ERROR");
    expect(range(d)).toEqual({ start: [1, 0, 0], end: [1, 2, 2] });
  });
});

describe("the two conditions a consumer copying the fields relies on", () => {
  const customTags: Record<string, CustomTag> = {
    box: {
      template: { filename: "/tags/box.mx", source: "<div></span>" },
    } as CustomTag,
    point: {
      template: { filename: "/tags/point.mx", source: "<div a=(x +)/>" },
    } as CustomTag,
    forTag: {
      template: { filename: "/tags/for.mx", source: "<for|x|/>" },
    } as CustomTag,
  };

  /** A corpus of sources with errors of every kind above. */
  const inFile: [string, LowerSourceOptions?][] = [
    ["<div>\n  <foo>\n    x\n  </foo>\n</div>\n", { unknownTags: "reject" }],
    ["<for|x|/>\n"],
    ["<const/x=1 y=2/>\n"],
    ["<div @a=1/>\n"],
    ["<div\n  x:=\n    (1 +\n 2)\n/>\n"],
    ["<div>\n  hello\n</div>\n", { structural: "reject" }],
    ["<div></span>\n"],
    ["<div>\n  <p>\n</div>\n"],
    ["<div x=(1 +)/>\n"],
    ["<div"],
    ["${a b}\n"],
    ["<@foo/>\n"],
    [",\n"],
    ["import x from 'y'\n<div/>\n", { structural: "reject" }],
    ["<!doctype html>\n<div/>\n", { structural: "reject" }],
    ["<pub/>\n", { customTags: { pub: { finalize: () => [] } } }],
    ["<if/>\n", { customTags: { if: {} } }],
    ["<foo/>\n<bar>\n", { unknownTags: "reject" }],
  ];

  it("`end.offset >= 0` for every diagnostic located in the lowered file", () => {
    let withEnd = 0;
    for (const [source, options] of inFile) {
      const { diagnostics } = lowerSource(source, "/t.mx", options);
      expect(diagnostics.length, source).toBeGreaterThan(0);
      for (const d of diagnostics) {
        expect(d.file, source).toBeUndefined();
        if (d.end === undefined) continue;
        withEnd++;
        // The offset is the offset of the end's line and column, never -1,
        // and the range does not run backwards.
        const lines = lineStartsOf(source);
        const expected = Math.min(
          (lines[d.end.line - 1] ?? source.length) + d.end.column,
          source.length,
        );
        expect(d.end.offset, `${source} ${d.message}`).toBe(expected);
        expect(d.end.offset).toBeGreaterThanOrEqual(0);
        expect(d.end.offset).toBeGreaterThanOrEqual(d.offset);
      }
    }
    // The corpus really has ranges: this is not vacuous.
    expect(withEnd).toBeGreaterThanOrEqual(inFile.length);
  });

  it("`end.offset === -1` only when `file` names another file, as for the start's `offset`", () => {
    const sources = [
      "<box/>\n",
      "<point/>\n",
      "<forTag/>\n",
      "<box/>\n<foo/>\n",
    ];
    let foreign = 0;
    for (const source of sources) {
      const { diagnostics } = lowerSource(source, "/app/page.mx", {
        customTags,
        unknownTags: "reject",
      });
      expect(diagnostics.length, source).toBeGreaterThan(0);
      for (const d of diagnostics) {
        const other = d.file !== undefined;
        expect(d.offset === -1, `${source} ${d.message}`).toBe(other);
        if (d.end === undefined) continue;
        expect(d.end.offset === -1, `${source} ${d.message}`).toBe(other);
        if (other) foreign++;
      }
    }
    // A foreign diagnostic with a range was really met.
    expect(foreign).toBeGreaterThanOrEqual(3);
  });

  it("a foreign diagnostic keeps the range it has in its own file", () => {
    const { diagnostics } = lowerSource("<box/>\n", "/app/page.mx", {
      customTags,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      file: "/tags/box.mx",
      line: 1,
      column: 5,
      offset: -1,
      end: { line: 1, column: 12, offset: -1 },
    });
    const point = lowerSource("<point/>\n", "/app/page.mx", { customTags });
    expect(point.diagnostics[0]).toMatchObject({
      file: "/tags/point.mx",
      end: { line: 1, column: 11, offset: -1 },
    });
  });
});

describe("toDiagnostic", () => {
  const source = "ab\ncd\n";
  const starts = lineStartsOf(source);
  const make = (at: Parameters<typeof toDiagnostic>[2]) =>
    toDiagnostic("error", "m", at, undefined, starts, source, "/t.mx");

  it("turns the end into an offset with the start's own rule", () => {
    expect(
      make({ line: 1, column: 1, end: { line: 2, column: 1 } }).end,
    ).toEqual({ line: 2, column: 1, offset: 4 });
  });

  it("is -1 for the end of a position in another file", () => {
    const d = make({
      line: 2,
      column: 0,
      file: "/other.mx",
      end: { line: 2, column: 2 },
    });
    expect([d.offset, d.end?.offset, d.file]).toEqual([-1, -1, "/other.mx"]);
  });

  it("drops the file marker when `file` is the lowered file", () => {
    const d = make({
      line: 1,
      column: 0,
      file: "/t.mx",
      end: { line: 1, column: 2 },
    });
    expect(d.file).toBeUndefined();
    expect(d.end).toEqual({ line: 1, column: 2, offset: 2 });
  });

  it("has no end for a file-level position", () => {
    expect(make({ line: 0, column: 0, end: { line: 1, column: 3 } })).toEqual({
      severity: "error",
      message: "m",
      line: 1,
      column: 0,
      offset: 0,
    });
  });

  it("has no end when none is given", () => {
    expect("end" in make({ line: 1, column: 1 })).toBe(false);
  });

  it("never lets the range run backwards", () => {
    expect(
      make({ line: 2, column: 1, end: { line: 1, column: 0 } }).end,
    ).toEqual({ line: 2, column: 1, offset: 4 });
  });
});
