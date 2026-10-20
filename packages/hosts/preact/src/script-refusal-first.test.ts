/**
 * On Preact a `<script>` is refused by the host, and that refusal is the only
 * diagnostic for the tag: a body that does not parse, a head the tag has no
 * use for and a `${…}` placeholder are not reported ahead of it. Message,
 * code and position are pinned, whole file and region alike.
 * Hono compiles through the same emitter; this is also its first-diagnostic
 * matrix home. Hono keeps both-door refusal spot-checks with its dialect name locally.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX templates, not JS template strings
import { createTargetLookup } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import descriptor from "./descriptor.ts";
import { compilePreactMx, compilePreactRegion } from "./index.ts";

const targets = createTargetLookup([descriptor]);

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

const whole = (source: string) =>
  refusal(() => compilePreactMx(source, "/fixtures/whole.mx", { targets }));

// A region inside a module: file line 3 (0-based 2), column 4, offset 40.
const region = (source: string) =>
  refusal(() =>
    compilePreactRegion(source, {
      filename: "/fixtures/Panel.preact.mx",
      baseOffset: 40,
      baseLine: 2,
      baseColumn: 4,
      targets,
    }),
  );

const REFUSAL =
  "`<script>` is not supported in embedded MX on Preact. Write client code in a module the component imports.";
const CODE = "MX_UNSUPPORTED_CONSTRUCT";

describe("Preact: a <script> is refused before its body is read", () => {
  it.each([
    ["a body that does not parse", "<script>const = 1;</script>"],
    ["a body that parses", "<script>go()</script>"],
    ["a head the tag has no use for", "<script(x)>go()</script>"],
    ["a placeholder in the body", "<script>go(${x})</script>"],
    ["an attribute only", "<script async/>"],
  ])("%s: the host refusal is the only error", (_name, source) => {
    expect(whole(source)).toEqual({
      message: REFUSAL,
      code: CODE,
      line: 1,
      column: 0,
    });
    expect(region(`<div/>\n${source}`)).toEqual({
      message: REFUSAL,
      code: CODE,
      line: 4,
      column: 0,
    });
  });

  it("a write to a const in the body is not read", () => {
    expect(whole("<const/c=1/>\n<div/>\n<script>c = 2;</script>")).toEqual({
      message: REFUSAL,
      code: CODE,
      line: 3,
      column: 0,
    });
  });

  it("a concise script with a bad body", () => {
    expect(whole("script\n  --\n  const = 1;\n  --")).toMatchObject({
      message: REFUSAL,
      code: CODE,
      line: 1,
      column: 0,
    });
  });

  it("a script nested in an element, with a bad body", () => {
    expect(whole("<div>\n  <script>const = 1;</script>\n</div>")).toMatchObject(
      { message: REFUSAL, code: CODE, line: 2, column: 2 },
    );
  });
});
