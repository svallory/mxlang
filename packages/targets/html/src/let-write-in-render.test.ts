// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * A `<let>` cannot be written while the template renders (core raises it for
 * every target that has `<let>`; the html target's default policy has it).
 * The strict policy refuses `<let>` itself, so it never reaches the write.
 */

const file = "/tmp/mx-let-write-test/page.mx";
const MESSAGE =
  "`count` is a `<let>` and cannot be written while the template renders. Write it in an event handler or a `<script>` body, or derive a value with `<const>`.";

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(source: string, options?: { strict?: boolean }): any {
  try {
    compile(source, file, options);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("the html target's default policy", () => {
  it.each([
    ["a placeholder", "<let/count=0/>\n<p>${count++}</p>\n", "count++"],
    ["an attribute", "<let/count=0/>\n<p class=(count += 1)/>\n", "count += 1"],
    [
      "a `<const>`",
      "<let/count=0/>\n<const/x=(count = 2)/>\n<p>${x}</p>\n",
      "count = 2",
    ],
    ["an `<if>`", "<let/count=0/>\n<if=(--count)>\n  <p/>\n</if>\n", "--count"],
    ["`<log>`", "<let/count=0/>\n<log=(count++)/>\n", "count++"],
    ["`<debug>`", "<let/count=0/>\n<debug=(count++)/>\n", "count++"],
    ["`<id>`", "<let/count=0/>\n<id/x=(count++)/>\n", "count++"],
    [
      "`<lifecycle>`",
      "<let/count=0/>\n<lifecycle onMount=(count++)/>\n",
      "count++",
    ],
    [
      "`<script>`",
      "<let/count=0/>\n<script value=(count++)></script>\n",
      "count++",
    ],
    ["a `<let>`'s own value", "<let/count=(count = 1)/>\n", "count = 1"],
    [
      "a `<let>`'s `valueChange` that is not a function",
      "<let/count=0 valueChange=(count = 1, null)/>\n",
      "count = 1",
    ],
    [
      "a `<for>` param default",
      "<let/count=0/>\n<for|x = (count++)| of=xs>\n  <p/>\n</for>\n",
      "count++",
    ],
    [
      "a `<define>` param default",
      "<let/count=0/>\n<define/D|a = count++|>\n  <p/>\n</define>\n",
      "count++",
    ],
    [
      "a `<define>` attribute",
      "<let/count=0/>\n<define/D a=(count++)/>\n<p>${D.a}</p>\n",
      "count++",
    ],
    [
      "a `<define>` spread",
      "<let/count=0/>\n<define/D ...(count = {})/>\n",
      "count = {}",
    ],
    [
      "a class method",
      "<let/count=0/>\n<p>${class { bump() { count++ } }}</p>\n",
      "count++",
    ],
  ])("refuses a write in %s", (_name, source, write) => {
    const error = thrown(source);
    const start = source.indexOf(write);
    const line = source.slice(0, start).split("\n").length;
    const column = start - (source.lastIndexOf("\n", start) + 1);
    expect(error.message).toBe(MESSAGE);
    expect(error.diagnosticCode).toBe("MX_LET_WRITE_IN_RENDER");
    expect([error.line, error.column]).toEqual([line, column]);
    expect(error.end).toEqual({ line, column: column + write.length });
    expect(error.fixes).toBeUndefined();
  });

  it.each([
    ["a function in an attribute", "<p data-x=(() => { count++ })/>"],
    ["a function called in a placeholder", "<p>${(() => { count++ })()}</p>"],
    ["a `<script>` body", "<script>count++</script>"],
    ["a shadowing parameter", "<p>${((count) => count++)(1)}</p>"],
    [
      "a function in a `<define>` attribute",
      "<define/D bump=(() => count++)/>",
    ],
    ["a read", "<p>${count}</p>"],
    ["a `<log>` read", "<log=(count)/>"],
    ["a function in a `<lifecycle>`", "<lifecycle onMount=(() => count++)/>"],
    ["a class field arrow", "<p>${class { x = () => count++ }}</p>"],
  ])("accepts %s", (_name, body) => {
    expect(thrown(`<let/count=0/>\n${body}\n`)).toBeUndefined();
  });
});

describe("the strict policy", () => {
  it("refuses `<let>` itself, and the write is not reported", () => {
    const error = thrown("<let/count=0/>\n<p>${count++}</p>\n", {
      strict: true,
    });
    expect(error.message).toBe(
      "`<let>` is reactive state and requires a runtime; this strict policy has no reactive target",
    );
    expect(error.message).not.toContain("cannot be written");
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    expect([error.line, error.column]).toEqual([1, 0]);
  });
});
