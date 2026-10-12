/**
 * A tag Astro does not support in embedded MX (`.astro.mx`) is refused with
 * core's one sentence, "`<X>` is not supported in embedded MX on Astro.", then
 * the host's hint when it has one. Message, code, position and end are pinned.
 */
import { describe, expect, it } from "vitest";
import { AstroTemplateError, lowerAstroMx } from "./astro-template.ts";

const FENCE = "---\nconst x = 1;\n---\n";
const CODE = "MX_UNSUPPORTED_CONSTRUCT";

function refusal(template: string) {
  try {
    lowerAstroMx(`${FENCE}${template}`, "Test.astro.mx");
  } catch (error) {
    if (!(error instanceof AstroTemplateError)) throw error;
    return {
      message: error.message,
      code: error.diagnosticCode,
      line: error.line,
      column: error.column,
      end: error.end,
    };
  }
  throw new Error("expected the file to fail lowering");
}

describe("Astro: a tag the host does not support", () => {
  it.each([
    [
      "<let/x=1/>",
      "`<let>` is not supported in embedded MX on Astro. An `.astro.mx` file renders static markup at build time.",
      4,
    ],
    [
      "<script>go()</script>",
      "`<script>` is not supported in embedded MX on Astro. An `.astro.mx` file renders static markup at build time.",
      7,
    ],
    [
      "<const/n=1/>",
      "`<const>` is not supported in embedded MX on Astro. Declare it in the `---` fence instead: an Astro template expression cannot declare a binding.",
      6,
    ],
  ])(
    "%s: the first sentence, then the hint",
    (template, message, endColumn) => {
      expect(refusal(template)).toEqual({
        message,
        code: CODE,
        line: 4,
        column: 0,
        end: { line: 4, column: endColumn },
      });
    },
  );

  it.each(["<effect/>", "<effect>go()</effect>", "<effect() { go() }/>"])(
    "<effect> %s has the first sentence only, never a fix-it",
    (template) => {
      const error = refusal(template);
      expect(error.message).toBe(
        "`<effect>` is not supported in embedded MX on Astro.",
      );
      expect(error.message).not.toContain("<script>");
      expect(error.code).toBe(CODE);
    },
  );

  it("<effect> is positioned at the tag name with its end", () => {
    expect(refusal("<div>\n  <effect() { go() }/>\n</div>")).toMatchObject({
      line: 5,
      column: 2,
      end: { line: 5, column: 9 },
    });
  });

  it("<return> says the same, with a hint for what to do instead", () => {
    expect(refusal("<return=1/>")).toMatchObject({
      message:
        "`<return>` is not supported in embedded MX on Astro. Move the markup into a `.mx` tag file if the value is what you need: an `.astro.mx` file is an Astro component, whose output is its markup, so there is nothing to return a value to.",
      code: CODE,
    });
  });
});
