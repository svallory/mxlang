import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

/**
 * Decision 139 is a *language* rule, so it has to fire on a JSX-shaped host
 * too — a preact template is the same Marko source and the same core lowering,
 * and a CDATA section is not markup a JSX tree can hold. This is the test
 * that would fail if the rejection had been put in a host instead of core.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the message quotes MX placeholder syntax, not a JS template
const CDATA_MESSAGE =
  '`<![CDATA[…]]>` is not supported: write the text inline, as `${"…"}` when it must stay raw, or in an attribute value';
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: the message quotes MX placeholder syntax, not a JS template
const DECLARATION_MESSAGE =
  "`<?…?>` (an XML declaration or processing instruction) is not supported: remove it";

function failure(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compilePreactMx(source, "/fixtures/test.mx");
  } catch (error) {
    const e = error as { message: string; line: number; column: number };
    return {
      message: e.message.replace(ANSI, ""),
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("CDATA sections and XML declarations (preact, decision 139)", () => {
  it("rejects a CDATA section at the `<`", () => {
    expect(failure("<a><![CDATA[ x ]]></a>\n")).toEqual({
      message: CDATA_MESSAGE,
      line: 1,
      column: 3,
    });
  });

  it("rejects an XML declaration at the `<`", () => {
    expect(failure('<?xml version="1.0"?>\n<a/>\n')).toEqual({
      message: DECLARATION_MESSAGE,
      line: 1,
      column: 0,
    });
  });
});
