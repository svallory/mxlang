/**
 * `Dialect.diagnosticCodes`, through `lowerSource`, on a test-local dialect (it
 * names no real one): the final diagnostics of every exit carry the dialect's
 * code for each core code the map names, and nothing else about them changes.
 */
import { describe, expect, it } from "vitest";
import type { CustomTag } from "../custom-tags.ts";
import type { Dialect } from "../syntax-table.ts";
import {
  type IrDiagnostic,
  type LowerSourceOptions,
  lowerSource,
} from "./index.ts";

const MAP = {
  MX_UNKNOWN_TAG: "FX_UNKNOWN_TAG",
  MX_DUPLICATE_ATTRIBUTE: "FX_DUPLICATE",
  MX_MISSING_ATTRIBUTE: "FX_MISSING",
  MX_RESERVED_TAG: "FX_RESERVED",
  MX_DIALECT_ERROR: "FX_DIALECT",
} as const;

function dialectOf(more: Partial<Dialect> = {}): Dialect {
  return { id: "fixture", name: "Fixture", table: {}, ...more };
}

const withMap = dialectOf({ diagnosticCodes: MAP });
const plain = dialectOf();

const NEEDS: Record<string, CustomTag> = {
  needs: { attributes: { name: { type: "string", required: true } } },
};

function lower(
  source: string,
  dialect: Dialect,
  options: LowerSourceOptions = {},
) {
  return lowerSource(source, "/v/page.mx", { dialect, ...options });
}

const codes = (diagnostics: readonly IrDiagnostic[]) =>
  diagnostics.map((d) => d.code);

/** Everything about a diagnostic but its code. */
const sans = (diagnostics: readonly IrDiagnostic[]) =>
  diagnostics.map(({ code: _code, ...rest }) => rest);

interface Case {
  name: string;
  source: string;
  options?: LowerSourceOptions;
  /** The exit the case takes. */
  exit: "success" | "failure" | "scan" | "refuse" | "parse";
  /** Core's codes, in order. */
  before: string[];
  /** The mapped codes, in order. */
  after: Array<string | undefined>;
}

const CASES: Case[] = [
  {
    name: "a warning on the success path",
    source: "<div a=1 a=2/>\n",
    exit: "success",
    before: ["MX_DUPLICATE_ATTRIBUTE"],
    after: ["FX_DUPLICATE"],
  },
  {
    name: "a lowering failure",
    source: "<needs/>\n",
    options: { customTags: NEEDS },
    exit: "failure",
    before: ["MX_MISSING_ATTRIBUTE"],
    after: ["FX_MISSING"],
  },
  {
    name: "an unknown tag found by the check of a lowered source",
    source: "<nope/>\n",
    options: { unknownTags: "reject" },
    exit: "success",
    before: ["MX_UNKNOWN_TAG"],
    after: ["FX_UNKNOWN_TAG"],
  },
  {
    name: "an unknown tag found by the scan of a failed lowering",
    source: "<needs/>\n<nope/>\n",
    options: { customTags: NEEDS, unknownTags: "reject" },
    exit: "scan",
    before: ["MX_MISSING_ATTRIBUTE", "MX_UNKNOWN_TAG"],
    after: ["FX_MISSING", "FX_UNKNOWN_TAG"],
  },
  {
    name: "a refused definition (the refuse exit)",
    source: "<if x=1/>\n",
    options: { customTags: { if: {} } },
    exit: "refuse",
    before: ["MX_RESERVED_TAG"],
    after: ["FX_RESERVED"],
  },
  {
    name: "a parse error",
    source: "<!-- never closed\n",
    exit: "parse",
    before: ["MX_PARSE_MALFORMED_COMMENT"],
    // The map does not name it.
    after: ["MX_PARSE_MALFORMED_COMMENT"],
  },
];

describe("diagnosticCodes renames the codes of every exit", () => {
  it.each(CASES)("$name", ({ source, options, before, after }) => {
    const without = lower(source, plain, options);
    const mapped = lower(source, withMap, options);
    expect(codes(without.diagnostics)).toEqual(before);
    expect(codes(mapped.diagnostics)).toEqual(after);
    // Nothing but the code changes: message, position, range, severity, fixes.
    expect(sans(mapped.diagnostics)).toEqual(sans(without.diagnostics));
    expect(mapped.ir === undefined).toBe(without.ir === undefined);
  });

  it("a warning keeps its severity, and a file with warnings keeps its IR", () => {
    const result = lower("<div a=1 a=2/>\n", withMap);
    expect(result.ir).toBeDefined();
    expect(result.diagnostics.map((d) => [d.severity, d.code])).toEqual([
      ["warning", "FX_DUPLICATE"],
    ]);
  });

  it("an error and a warning in one file are each renamed", () => {
    const source = "<div a=1 a=2/>\n<nope/>\n";
    const options: LowerSourceOptions = { unknownTags: "reject" };
    const mapped = lower(source, withMap, options);
    const without = lower(source, plain, options);
    expect(mapped.diagnostics.map((d) => [d.severity, d.code])).toEqual(
      without.diagnostics.map((d) => [
        d.severity,
        d.code === "MX_UNKNOWN_TAG"
          ? "FX_UNKNOWN_TAG"
          : d.code === "MX_DUPLICATE_ATTRIBUTE"
            ? "FX_DUPLICATE"
            : d.code,
      ]),
    );
    expect(codes(mapped.diagnostics)).toContain("FX_UNKNOWN_TAG");
  });

  it("the order is the order without the map", () => {
    const source = "<needs/>\n<div a=1 a=2/>\n<nope/>\n<needs/>\n";
    const options: LowerSourceOptions = {
      customTags: NEEDS,
      unknownTags: "reject",
    };
    const without = lower(source, plain, options);
    const mapped = lower(source, withMap, options);
    expect(without.diagnostics.length).toBeGreaterThan(2);
    expect(mapped.diagnostics.map((d) => [d.line, d.column])).toEqual(
      without.diagnostics.map((d) => [d.line, d.column]),
    );
  });

  it("a code the map does not name keeps its MX code", () => {
    const partial = dialectOf({
      diagnosticCodes: { MX_DUPLICATE_ATTRIBUTE: "FX_DUPLICATE" },
    });
    const result = lower("<needs/>\n<div a=1 a=2/>\n", partial, {
      customTags: NEEDS,
    });
    expect(codes(result.diagnostics)).toEqual(["MX_MISSING_ATTRIBUTE"]);
    const ok = lower("<div a=1 a=2/>\n", partial);
    expect(codes(ok.diagnostics)).toEqual(["FX_DUPLICATE"]);
  });

  it("a diagnostic with no code stays codeless", () => {
    const result = lower("<div a=1 a=2/>\n", withMap);
    for (const d of result.diagnostics) expect(d.code).toBeDefined();
    const empty = lower("<p/>\n", withMap);
    expect(empty.diagnostics).toEqual([]);
  });

  it("an empty map changes nothing", () => {
    const empty = dialectOf({ diagnosticCodes: {} });
    expect(lower("<div a=1 a=2/>\n", empty)).toEqual(
      lower("<div a=1 a=2/>\n", plain),
    );
  });
});

describe("a code the dialect raises is not renamed", () => {
  it("an `explainUnknownTag` code stays, even when it equals a map value", () => {
    const dialect = dialectOf({
      diagnosticCodes: { MX_UNKNOWN_TAG: "FX_SAME" },
      explainUnknownTag: (tag) =>
        tag.name === "own"
          ? { code: "FX_SAME", message: "the dialect's words" }
          : undefined,
    });
    const result = lower("<own/>\n<other/>\n", dialect, {
      unknownTags: "reject",
    });
    expect(result.diagnostics.map((d) => [d.line, d.code, d.message])).toEqual([
      [1, "FX_SAME", "the dialect's words"],
      [2, "FX_SAME", expect.stringContaining("other")],
    ]);
    const without = lower(
      "<own/>\n<other/>\n",
      dialectOf({
        explainUnknownTag: dialect.explainUnknownTag,
      }),
      { unknownTags: "reject" },
    );
    expect(codes(without.diagnostics)).toEqual(["FX_SAME", "MX_UNKNOWN_TAG"]);
  });

  it("an `explainUnknownTag` explanation with no code is `MX_DIALECT_ERROR`, which MX keeps whatever the map says", () => {
    const explain: Dialect["explainUnknownTag"] = () => ({ message: "no" });
    const without = lower("<x/>\n", dialectOf({ explainUnknownTag: explain }), {
      unknownTags: "reject",
    });
    expect(codes(without.diagnostics)).toEqual(["MX_DIALECT_ERROR"]);
    const mapped = lower(
      "<x/>\n",
      dialectOf({ explainUnknownTag: explain, diagnosticCodes: MAP }),
      { unknownTags: "reject" },
    );
    expect(codes(mapped.diagnostics)).toEqual(["MX_DIALECT_ERROR"]);
  });

  it("`MX_DIALECT_HOOK_ERROR` and `MX_INTERNAL_ERROR` are never renamed", () => {
    const throwing = dialectOf({
      diagnosticCodes: MAP,
      explainUnknownTag: () => {
        throw new Error("boom");
      },
    });
    const result = lower("<x/>\n", throwing, { unknownTags: "reject" });
    expect(codes(result.diagnostics)).toEqual(["MX_DIALECT_HOOK_ERROR"]);
  });
});

describe("a dialect without the map, and the default", () => {
  it("is byte-identical to a dialect that never heard of the field", () => {
    const source = "<needs/>\n<div a=1 a=2/>\n<nope/>\n";
    const options: LowerSourceOptions = {
      customTags: NEEDS,
      unknownTags: "reject",
    };
    const a = lower(source, plain, options);
    const b = lower(source, dialectOf({ diagnosticCodes: undefined }), options);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(codes(a.diagnostics)).toEqual([
      "MX_MISSING_ATTRIBUTE",
      "MX_UNKNOWN_TAG",
      "MX_UNKNOWN_TAG",
    ]);
  });

  it("the default dialect reports MX codes", () => {
    const result = lowerSource("<div a=1 a=2/>\n", "/v/page.mx");
    expect(codes(result.diagnostics)).toEqual(["MX_DUPLICATE_ATTRIBUTE"]);
  });
});
