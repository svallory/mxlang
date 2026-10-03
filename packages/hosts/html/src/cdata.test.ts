import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Decision 139: `<![CDATA[…]]>` and `<?…?>` are positioned errors on every
 * target, as they are in Marko 6.3.51. Before it, core's IR had no node for
 * either, so both were dropped in lowering — `<a><![CDATA[ x ]]></a>`
 * compiled to `"<a></a>"` with no diagnostic at all.
 *
 * The raw-text half of the same story is pinned here rather than in core,
 * because "is this CDATA or is this text" is a *parser* answer and Marko's own
 * lookup is what makes `<style>`, `<textarea>` and `<title>` raw text. Probed
 * on this target before the fix: `<style><![CDATA[ x ]]></style>` emitted
 * `"<style><![CDATA[ x ]]></style>"` (text, kept) while
 * `<div><![CDATA[ x ]]></div>` emitted `"<div></div>"` (a node, silently
 * dropped). The same split is what the fix turns into "error" on one side and
 * "untouched" on the other.
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
    compile(source, "/fixtures/test.mx");
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

describe("CDATA sections and XML declarations (html, decision 139)", () => {
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

  it("leaves a raw-text `<style>` body as text", () => {
    // Probed, not assumed. Marko's own lookup marks `style` (and `textarea`,
    // `title`) as raw text, so its parser reads the body as one `MarkoText`
    // and there is no CDATA node to reject: the construct reaches the output
    // verbatim. This is the case the fix must *not* touch.
    const { code } = compile(
      "<style><![CDATA[ a < b ]]></style>\n",
      "/fixtures/test.mx",
    );
    expect(code).toContain("<![CDATA[ a < b ]]>");
  });

  it("leaves a raw-text `<textarea>` body as text", () => {
    const { code } = compile(
      "<textarea><![CDATA[ a < b ]]></textarea>\n",
      "/fixtures/test.mx",
    );
    expect(code).toContain("<![CDATA[ a < b ]]>");
  });

  it("does not reject a CDATA-looking string in `<script>` or an attribute", () => {
    // `<script>` is raw text too, so its body is one `MarkoText` node. The
    // html emitter does not write a `<script>` body's text in template mode
    // (pre-existing, and nothing to do with this decision), so what is pinned
    // here is the *node*: no CDATA error is raised. The node kind itself is
    // pinned in core's `lower.test.ts`.
    expect(() =>
      compile(
        '<script>var s = "<![CDATA[x]]>";</script>\n',
        "/fixtures/test.mx",
      ),
    ).not.toThrow();
    const { code } = compile('<a b="<![CDATA[ x ]]>"/>\n', "/fixtures/test.mx");
    // The attribute value is escaped on the way out (`&lt;`/`&gt;`), so the
    // assertion is on the construct itself, escaping-independent.
    expect(code).toContain("![CDATA[ x ]]");
  });
});
