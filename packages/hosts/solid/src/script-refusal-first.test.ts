/**
 * On Solid a `<script>` is refused by the host, and that refusal is the only
 * diagnostic for the tag: a body that does not parse, a head the tag has no
 * use for and a `${…}` placeholder are not reported ahead of it. Message,
 * code and position are pinned, whole file and region alike.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { describe, expect, it } from "vitest";
import { compileSolidMx, compileSolidUnit } from "./index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

interface Refusal {
  message: string;
  code?: string;
  line: number;
  column: number;
}

function refusal(run: () => unknown): Refusal {
  try {
    run();
  } catch (error) {
    const e = error as Refusal & { diagnosticCode?: string };
    return {
      message: stripAnsi(e.message),
      code: e.diagnosticCode,
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("expected a compile error");
}

const region = (source: string) =>
  refusal(() => compileSolidMx(source, { filename: "/fixtures/p.solid.mx" }));
const unit = (source: string) =>
  refusal(() => compileSolidUnit(source, { filename: "/fixtures/tag.mx" }));

const REFUSAL =
  "`<script>` is not supported in embedded MX on Solid. Write client code in the surrounding TypeScript module.";
const CODE = "MX_UNSUPPORTED_CONSTRUCT";

describe("Solid: a <script> is refused before its body is read", () => {
  it.each([
    ["a body that does not parse", "<script>const = 1;</script>"],
    ["a body that parses", "<script>go()</script>"],
    ["a head the tag has no use for", "<script(x)>go()</script>"],
    ["a placeholder in the body", "<script>go(${x})</script>"],
    ["an attribute only", "<script async/>"],
  ])("%s: the host refusal is the only error", (_name, source) => {
    const expected = { message: REFUSAL, code: CODE, line: 1, column: 0 };
    expect(region(source)).toEqual(expected);
    expect(unit(source)).toEqual(expected);
  });

  it("a write to a const in the body is not read", () => {
    expect(region("<const/c=1/>\n<div/>\n<script>c = 2;</script>")).toEqual({
      message: REFUSAL,
      code: CODE,
      line: 3,
      column: 0,
    });
  });

  it("a concise script with a bad body", () => {
    const source = "script\n  --\n  const = 1;\n  --";
    expect(region(source)).toMatchObject({ message: REFUSAL, code: CODE });
    expect(unit(source)).toMatchObject({ message: REFUSAL, code: CODE });
  });

  it("a script nested in an element, with a bad body", () => {
    expect(
      region("<div>\n  <script>const = 1;</script>\n</div>"),
    ).toMatchObject({
      message: REFUSAL,
      code: CODE,
      line: 2,
      column: 2,
    });
  });
});
