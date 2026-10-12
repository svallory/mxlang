import { expect, it } from "vitest";
import { compileHonoMx as compile } from "./index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: compiler code frames may be coloured
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function parseReason(source: string) {
  try {
    compile(source, "/fixtures/Test.mx");
  } catch (error) {
    const message = stripAnsi((error as Error).message);
    return message
      .split("\n")
      .find((line) => /\|\s+\^/.test(line))
      ?.replace(/^.*\^ /, "");
  }
  throw new Error("Expected a parse error");
}

/** The error a compile raised: its text, code and authored position. */
function failure(source: string) {
  try {
    compile(source, "/fixtures/Test.mx");
  } catch (error) {
    const e = error as Error & {
      code?: string;
      line?: number;
      column?: number;
    };
    return {
      message: stripAnsi(e.message),
      code: e.code,
      line: e.line,
      column: e.column,
    };
  }
  throw new Error("Expected a compile error");
}

// A `let` or `var` is mutable, so the immutable `<const>` fix would change its
// meaning; the fix is to take the statement out of the template.
it.each(["let", "var"])(
  "$ %s states the rule and the fix, at the statement",
  (keyword) => {
    expect(failure(`<p>1</p>\n$ ${keyword} x = 1;\n<p>1</p>`)).toEqual({
      message:
        "scriptlets (`$ statement`) are not supported in MX; move the statement out of the template",
      code: "BABEL_TRANSFORM_ERROR",
      line: 2,
      column: 0,
    });
    expect(parseReason(`$ ${keyword} x = ;\n<p>1</p>`)).toBe(
      "Unexpected token; scriptlets (`$ …`) are not supported; move the statement out of the template",
    );
    expect(() => compile("<let/x=1/>", "/fixtures/Test.mx")).toThrow(
      "`<let>` is Marko reactive state",
    );
  },
);
