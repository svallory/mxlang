import { describe, expect, it } from "vitest";
import { compileSource } from "../compile.ts";
import type { CustomTag } from "../custom-tags.ts";
import type { HostDeclarations } from "../declarations.ts";
import { testTargetLookup } from "../test-targets.ts";
import { lowerSource } from "./index.ts";

/**
 * The stable codes of the errors a consumer used to match by text. Each is
 * asserted through `lowerSource` with its exact position (`line`, 1-based;
 * `column`, 0-based; `offset`), and the message is pinned so a code is never
 * added by rewording.
 */

const D = "${";

const closed: Record<string, CustomTag> = {
  card: { children: { item: {} } },
  item: {},
  empty: { children: {} },
  rows: { children: { item: {}, "*": { pattern: "^row-.*$" } } },
};

function only(source: string, options: Parameters<typeof lowerSource>[2]) {
  const result = lowerSource(source, "/t.mx", options);
  expect(result.ir).toBeUndefined();
  return result.diagnostics;
}

describe("MX_UNKNOWN_TAG", () => {
  it("rides the check path (an IR that lowered)", () => {
    expect(
      only("<p>\n  <opem/>\n</p>\n", {
        customTags: { open: {}, p: {} },
        unknownTags: "reject",
      }),
    ).toEqual([
      {
        severity: "error",
        message:
          "`<opem>` is not a known tag: no contract for it was given; did you mean `<open>`?",
        line: 2,
        column: 2,
        offset: 6,
        end: { line: 2, column: 7, offset: 11 },
        code: "MX_UNKNOWN_TAG",
      },
    ]);
  });

  it("rides the scan path (a source whose lowering failed)", () => {
    const diagnostics = only(
      `<card>\n  <opem/>\n  <item a=(1 2)/>\n</card>\n`,
      {
        customTags: closed,
        unknownTags: "reject",
      },
    );
    const unknown = diagnostics.find((d) => d.message.includes("not a known"));
    expect(unknown).toEqual({
      severity: "error",
      message: "`<opem>` is not a known tag: no contract for it was given",
      line: 2,
      column: 2,
      offset: 9,
      end: { line: 2, column: 7, offset: 14 },
      code: "MX_UNKNOWN_TAG",
    });
  });

  it("keeps the code of an error the unknown-tag label rewrites", () => {
    // `<empty>` is declared but not a child of `<card>`: its not-allowed error
    // stays (an unknown `<bad>` there would give the unknown-tag error alone).
    const diagnostics = only(`<opem>\n  <card><empty/></card>\n</opem>\n`, {
      customTags: closed,
      unknownTags: "reject",
    });
    const inner = diagnostics.find((d) => d.message.includes("<empty>"));
    expect(inner).toMatchObject({
      code: "MX_TAG_NOT_ALLOWED",
      line: 2,
      column: 8,
      offset: 15,
    });
    expect(inner?.message).toContain("is not allowed here");
    expect(inner?.message).toContain("inside the unknown tag");
  });
});

describe("MX_TAG_NOT_ALLOWED", () => {
  it("closed record (no wildcard)", () => {
    expect(only("<card>\n  <bad/>\n</card>\n", { customTags: closed })).toEqual(
      [
        {
          severity: "error",
          message:
            "`<card>`: `<bad>` is not allowed here; allowed children: `<item>`",
          line: 2,
          column: 2,
          offset: 9,
          code: "MX_TAG_NOT_ALLOWED",
        },
      ],
    );
  });

  it("empty record", () => {
    expect(
      only("<empty>\n  <bad/>\n</empty>\n", { customTags: closed }),
    ).toEqual([
      {
        severity: "error",
        message:
          "`<empty>`: `<bad>` is not allowed here; allowed children: none",
        line: 2,
        column: 2,
        offset: 10,
        code: "MX_TAG_NOT_ALLOWED",
      },
    ]);
  });

  it("wildcard record", () => {
    expect(only("<rows>\n  <bad/>\n</rows>\n", { customTags: closed })).toEqual(
      [
        {
          severity: "error",
          message:
            "`<rows>`: `<bad>` is not allowed here; allowed children: `<item>`; other names must match `^row-.*$`",
          line: 2,
          column: 2,
          offset: 9,
          code: "MX_TAG_NOT_ALLOWED",
        },
      ],
    );
  });
});

describe("MX_TEXT_NOT_ALLOWED", () => {
  it("text in a closed record", () => {
    expect(only("<card>\n  hi\n</card>\n", { customTags: closed })).toEqual([
      {
        severity: "error",
        message:
          "`<card>`: text is not allowed here; it accepts only the child tags `<item>`",
        line: 2,
        column: 2,
        offset: 9,
        code: "MX_TEXT_NOT_ALLOWED",
      },
    ]);
  });

  it("text in an empty record", () => {
    expect(
      only("<empty>\n-- hello\n</empty>\n", { customTags: closed }),
    ).toEqual([
      {
        severity: "error",
        message:
          "`<empty>`: text is not allowed here; it accepts no child tags",
        line: 2,
        column: 0,
        offset: 8,
        code: "MX_TEXT_NOT_ALLOWED",
      },
    ]);
  });
});

describe("MX_EXPECTED_SINGLE_EXPRESSION", () => {
  it("an attribute's placeholder", () => {
    expect(only(`<x b=${D}1 2}/>\n`, {})).toEqual([
      {
        severity: "error",
        message: "Expected a single expression, but found `{` after it.",
        line: 1,
        column: 6,
        offset: 6,
        end: { line: 1, column: 6, offset: 6 },
        code: "MX_EXPECTED_SINGLE_EXPRESSION",
      },
    ]);
  });

  it("a default value followed by a spaced `:` (Mesh's case)", () => {
    expect(only("<x=1 :n=2/>\n", {})).toEqual([
      {
        severity: "error",
        message: "Expected a single expression, but found `:` after it.",
        line: 1,
        column: 5,
        offset: 5,
        end: { line: 1, column: 5, offset: 5 },
        code: "MX_EXPECTED_SINGLE_EXPRESSION",
      },
    ]);
  });

  it("a placeholder in a tag body", () => {
    expect(only(`<x>${D}1 2}</x>\n`, {})).toEqual([
      {
        severity: "error",
        message: "Expected a single expression, but found `2` after it.",
        line: 1,
        column: 7,
        offset: 7,
        end: { line: 1, column: 7, offset: 7 },
        code: "MX_EXPECTED_SINGLE_EXPRESSION",
      },
    ]);
  });

  it("an unrelated parse error carries no code", () => {
    const [diagnostic] = only(`<x a=(1 +)/>\n`, {});
    expect(diagnostic).toBeDefined();
    expect(diagnostic).not.toHaveProperty("code");
  });
});

describe("the template compile path reports the same codes", () => {
  const targets = testTargetLookup();
  const declarations: HostDeclarations = {
    tags: {},
    isElement: () => true,
    isComponent: (name, ctx) => ctx.defines.has(name),
  };
  function thrown(source: string): unknown[] {
    try {
      compileSource(source, "/tmp/mx-codes-test/page.mx", declarations, {
        targets,
        customTags: closed,
        tagDiscoveryDirs: [],
        emitIr: () => "",
      });
    } catch (error) {
      const all = (error as { errors?: unknown[] }).errors;
      return all && all.length > 0 ? all : [error];
    }
    throw new Error("expected a throw");
  }
  const codes = (errors: unknown[]) =>
    errors.map((e) => (e as { diagnosticCode?: string }).diagnosticCode);

  it("parse error", () => {
    const errors = thrown(`<x>${D}1 2}</x>\n`);
    expect(codes(errors)).toEqual(["MX_EXPECTED_SINGLE_EXPRESSION"]);
    expect(String((errors[0] as Error).message)).toContain(
      "Expected a single expression, but found `2` after it.",
    );
  });

  it("tag not allowed", () => {
    expect(codes(thrown("<card>\n  <bad/>\n</card>\n"))).toEqual([
      "MX_TAG_NOT_ALLOWED",
    ]);
  });

  it("text not allowed", () => {
    expect(codes(thrown("<card>\n  hi\n</card>\n"))).toEqual([
      "MX_TEXT_NOT_ALLOWED",
    ]);
  });
});
