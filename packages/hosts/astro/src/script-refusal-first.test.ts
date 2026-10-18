// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * On Astro a `<script>` is refused by the host, and that refusal is the only
 * diagnostic for the tag: its body and head are not read.
 */
import { describe, expect, it } from "vitest";
import { AstroTemplateError, lowerAstroMx } from "./astro-template.ts";

const FENCE = "---\nconst x = 1;\n---\n";

const ROWS: [string, string, number][] = [
  ["a body that does not parse", "<script>const = 1;</script>", 0],
  ["a body that parses", "<script>go()</script>", 0],
  ["a head the tag has no use for", "<script(x)>go()</script>", 0],
  ["a placeholder in the body", "<script>go(${x})</script>", 0],
  ["an attribute only", "<script async/>", 0],
  ["a concise body that does not parse", "script\n  --\n  const = 1;\n  --", 0],
];

const REFUSAL = "`<script>` is not supported in embedded MX on Astro.";

describe("Astro: a <script> is refused before its body is read", () => {
  it.each(ROWS)(
    "%s: the host refusal is the only error",
    (_n, source, line) => {
      try {
        lowerAstroMx(`${FENCE}${source}`, "Test.astro.mx");
      } catch (error) {
        if (!(error instanceof AstroTemplateError)) throw error;
        expect(error.message).toContain(REFUSAL);
        expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
        expect([error.line, error.column]).toEqual([line + 4, 0]);
        return;
      }
      throw new Error("expected the file to fail lowering");
    },
  );
});
