// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
/**
 * On Angular a `<script>` is refused by the host, and that refusal is the only
 * diagnostic for the tag: its body and head are not read.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const ROWS: [string, string, number][] = [
  ["a body that does not parse", "<script>const = 1;</script>", 0],
  ["a body that parses", "<script>go()</script>", 0],
  ["a head the tag has no use for", "<script(x)>go()</script>", 0],
  ["a placeholder in the body", "<script>go(${x})</script>", 0],
  ["an attribute only", "<script async/>", 0],
  ["a concise body that does not parse", "script\n  --\n  const = 1;\n  --", 0],
  [
    "a write to a const in the body",
    "<const/c=1/>\n<div/>\n<script>c = 2;</script>",
    2,
  ],
];

const REFUSAL =
  "`<script>` is not supported in embedded MX on Angular. Write client code in the component class.";

describe("Angular: a <script> is refused before its body is read", () => {
  it.each(ROWS)(
    "%s: the host refusal is the only error",
    (_n, source, line) => {
      try {
        compile(source, "/fixtures/page.mx");
      } catch (error) {
        const e = error as Error & {
          diagnosticCode?: string;
          line: number;
          column: number;
        };
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
        const message = e.message.replace(/\u001b\[[0-9;]*m/g, "");
        expect(message).toBe(REFUSAL);
        expect(e.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
        expect([e.line, e.column]).toEqual([line + 1, 0]);
        return;
      }
      throw new Error("expected a compile error");
    },
  );
});
