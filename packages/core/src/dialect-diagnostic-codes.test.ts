/**
 * `Dialect.diagnosticCodes` is validated when the dialect loads: a bad map
 * fails the dialect with a named error, through the `dialect` option and
 * through a dialect module alike. The dialect `lexi` is a fixture.
 */
import { describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";
import type { Dialect } from "./syntax-table.ts";

function lexi(diagnosticCodes: unknown): Dialect {
  return { id: "lexi", name: "Lexi", table: {}, diagnosticCodes } as Dialect;
}

/** The one diagnostic a bad dialect option produces. */
function refusal(diagnosticCodes: unknown) {
  const result = lowerSource("<p/>\n", "/v/page.mx", {
    dialect: lexi(diagnosticCodes),
  });
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toHaveLength(1);
  const [only] = result.diagnostics;
  return only as NonNullable<typeof only>;
}

const RESERVED = (code: string) =>
  `code \`${code}\` starts with \`MX_\`, which is MX's own prefix for its diagnostic codes; use the dialect's own prefix`;

describe("a bad `diagnosticCodes` map fails the dialect at load", () => {
  it.each([
    ["a string", "MX_UNKNOWN_TAG"],
    ["an array", ["MX_UNKNOWN_TAG"]],
    ["null", null],
    ["a number", 3],
    ["a class instance", new (class Codes {})()],
  ])("%s is not a plain object", (_, value) => {
    const diagnostic = refusal(value);
    expect(diagnostic.code).toBe("MX_INVALID_DIALECT_MODULE");
    expect(diagnostic.message).toContain(
      "`dialect.diagnosticCodes` must be an object mapping core diagnostic codes to the dialect's codes",
    );
  });

  it("a key that is not a core code names the key", () => {
    const diagnostic = refusal({ MX_UNKNOWN_TAG: "A_B", MX_NOPE: "A_C" });
    expect(diagnostic.message).toContain(
      "`dialect.diagnosticCodes.MX_NOPE`: `MX_NOPE` is not a core diagnostic code",
    );
  });

  it("a dialect's own code is not a key", () => {
    const diagnostic = refusal({ LEXI_CODE: "LEXI_OTHER" });
    expect(diagnostic.message).toContain(
      "`dialect.diagnosticCodes.LEXI_CODE`: `LEXI_CODE` is not a core diagnostic code",
    );
  });

  it.each([["MX_INTERNAL_ERROR"], ["MX_DIALECT_HOOK_ERROR"]])(
    "%s stays MX's and cannot be a key",
    (key) => {
      const diagnostic = refusal({ [key]: "LEXI_X" });
      expect(diagnostic.message).toContain(
        `\`dialect.diagnosticCodes.${key}\`: \`${key}\` stays MX's own code and cannot be renamed`,
      );
    },
  );

  it.each([
    ["a number", 3],
    ["an empty string", ""],
    ["null", null],
    ["an object", {}],
    ["undefined", undefined],
  ])("a value that is %s is not a code", (_, value) => {
    const diagnostic = refusal({ MX_UNKNOWN_TAG: value });
    expect(diagnostic.message).toContain(
      "`dialect.diagnosticCodes.MX_UNKNOWN_TAG` must be a non-empty string: the dialect's code",
    );
  });

  it("a value starting with `MX_` is refused with the hook-code wording", () => {
    const diagnostic = refusal({ MX_UNKNOWN_TAG: "MX_OTHER" });
    expect(diagnostic.message).toContain(
      `\`dialect.diagnosticCodes.MX_UNKNOWN_TAG\`: ${RESERVED("MX_OTHER")}`,
    );
  });

  it("names the first bad entry", () => {
    const diagnostic = refusal({
      MX_UNKNOWN_TAG: "",
      MX_DUPLICATE_ATTRIBUTE: "MX_X",
    });
    expect(diagnostic.message).toContain("diagnosticCodes.MX_UNKNOWN_TAG`");
    expect(diagnostic.message).not.toContain("MX_DUPLICATE_ATTRIBUTE");
  });
});

describe("a good `diagnosticCodes` map loads", () => {
  it("accepts MX_DIALECT_ERROR as a key", () => {
    const result = lowerSource("<p/>\n", "/v/page.mx", {
      dialect: lexi({ MX_DIALECT_ERROR: "LEXI_ERROR" }),
    });
    expect(result.ir).toBeDefined();
  });

  it("accepts two keys that share one value", () => {
    const result = lowerSource("<div a=1 a=2/>\n<nope/>\n", "/v/page.mx", {
      dialect: lexi({
        MX_UNKNOWN_TAG: "LEXI_BAD",
        MX_DUPLICATE_ATTRIBUTE: "LEXI_BAD",
      }),
      unknownTags: "reject",
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "LEXI_BAD",
      "LEXI_BAD",
    ]);
  });

  it("accepts a map that renames a template parse code", () => {
    const result = lowerSource("<!-- never closed\n", "/v/page.mx", {
      dialect: lexi({ MX_PARSE_MALFORMED_COMMENT: "LEXI_COMMENT" }),
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["LEXI_COMMENT"]);
  });

  it("accepts an empty map and an absent one", () => {
    for (const map of [{}, undefined]) {
      const result = lowerSource("<p/>\n", "/v/page.mx", {
        dialect: lexi(map),
      });
      expect(result.ir).toBeDefined();
    }
  });
});
