import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import { TranslateError } from "./core.ts";
import type { HostDeclarations } from "./declarations.ts";
import { lowerSource } from "./ir-entry/index.ts";
import { testTargetLookup } from "./test-targets.ts";

/**
 * User-visible core errors state a rule and a fix. They cite no decision
 * number, ruling or internal document, and a message that says "this
 * language" names the product (`productName`), not MX.
 */

const SCRIPTLET = "scriptlets (`$ statement`) are not supported in MX";
const GENERIC_FIX =
  "a template holds values, not statements: write a value with `<const/x=…/>`, or move the statement out of the template";

describe("the scriptlet error", () => {
  it.each([
    [
      "$ foo()\n",
      `${SCRIPTLET}; ${GENERIC_FIX}`,
      1,
      0,
      0,
      { line: 1, column: 7, offset: 7 },
    ],
    [
      "$ const y = 1\n",
      `${SCRIPTLET}; declare a value with \`<const/y=…/>\``,
      1,
      0,
      0,
      { line: 1, column: 13, offset: 13 },
    ],
    [
      "<div/>\n$ let z = 2;\n",
      `${SCRIPTLET}; declare a value with \`<let/z=…/>\``,
      2,
      0,
      7,
      { line: 2, column: 12, offset: 19 },
    ],
  ])(
    "%j reads exactly, positioned at the `$`",
    (source, message, line, column, offset, end) => {
      expect(lowerSource(source, "/t.mx").diagnostics).toEqual([
        {
          severity: "error",
          message,
          line,
          column,
          offset,
          end,
          code: "MX_UNSUPPORTED_CONSTRUCT",
        },
      ]);
    },
  );

  it("names the product a dialect passes, with no decision number", () => {
    const declarations: HostDeclarations = {
      tags: {},
      isElement: () => true,
      isComponent: () => false,
    };
    let error: unknown;
    try {
      compileSource(
        "$ foo()\n",
        "/tmp/mx-error-wording/page.mx",
        declarations,
        {
          targets: testTargetLookup(),
          tagDiscoveryDirs: [],
          warnings: [],
          emitIr: () => "",
          productName: "Acme",
        },
      );
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TranslateError);
    expect((error as TranslateError).message).toBe(
      `scriptlets (\`$ statement\`) are not supported in Acme; ${GENERIC_FIX}`,
    );
  });

  describe("continued on a more-indented line", () => {
    const HINT = "scriptlets (`$ …`) are not supported";
    type Entry = Error & {
      label?: string;
      loc?: { start: { line: number; column: number } };
      diagnosticCode?: string;
    };

    function compileError(source: string): Entry & { errors?: Entry[] } {
      try {
        compileSource(
          source,
          "/tmp/mx-error-wording/page.mx",
          { tags: {}, isElement: () => true, isComponent: () => false },
          {
            targets: testTargetLookup(),
            tagDiscoveryDirs: [],
            warnings: [],
            emitIr: () => "",
          },
        );
      } catch (cause) {
        return cause as Entry & { errors?: Entry[] };
      }
      throw new Error("expected a compile error");
    }

    const summary = (entry: Entry) => ({
      label: entry.label,
      line: entry.loc?.start.line,
      column: entry.loc?.start.column,
      code: entry.diagnosticCode,
    });

    it("hints both entries of g0504 with the declared name", () => {
      const error = compileError("$ const a = 1 + \n  2");
      expect(error.errors?.map(summary)).toEqual([
        {
          label: `Unexpected token; ${HINT}; declare a value with \`<const/a=…/>\``,
          line: 1,
          column: 16,
          code: "MX_PARSE_EXPRESSION",
        },
        {
          label: `Line has extra indentation at the beginning; ${HINT}; declare a value with \`<const/a=…/>\``,
          line: 2,
          column: 2,
          code: "MX_PARSE_INVALID_INDENTATION",
        },
      ]);
      // With colours on, Marko wraps the frame in escape codes.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
      const plain = error.message.replace(/\u001b\[[0-9;]*m/g, "");
      expect(plain).toContain(
        `> 2 |   2\n        |   ^ Line has extra indentation at the beginning; ${HINT}; declare a value with \`<const/a=…/>\``,
      );
    });

    it("hints g0506 with the generic tail", () => {
      const error = compileError("$ a = b\n  && c");
      expect(error.errors).toBeUndefined();
      expect(summary(error)).toEqual({
        label: `Line has extra indentation at the beginning; ${HINT}; ${GENERIC_FIX}`,
        line: 2,
        column: 2,
        code: "MX_PARSE_INVALID_INDENTATION",
      });
    });
  });
});
