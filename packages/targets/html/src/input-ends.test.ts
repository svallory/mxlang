// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * Input that ends inside a concise open delimiter (decision 161). The front
 * end's `MX_INPUT_ENDS_IN_DELIMITER` is raised last: where main's compile
 * reported an error for such input, that error still comes first, with
 * main's text (its position is now the tag's, where main's tag had none);
 * the new error fires only where main compiled.
 */
function run(
  source: string,
): { message: string; line: number; column: number } | undefined {
  try {
    compile(source, "a.mx");
  } catch (error) {
    const { message, line, column } = error as {
      message: string;
      line: number;
      column: number;
    };
    return { message: message.split("\n")[0] as string, line, column };
  }
  return undefined;
}

describe("input ending inside a concise open delimiter", () => {
  it.each([
    ["div(a", "Tag does not support arguments.", 1, 4],
    ["div (a", "Tag does not support arguments.", 1, 5],
    [
      "div|a",
      "tag params `|...|` on `<div>` are not supported in a standalone template",
      1,
      0,
    ],
    ["x<a", "Unable to find entry point for custom tag `<x>`.", 1, 0],
    ["x<a x=`${<a>", "Unable to find entry point for custom tag `<x>`.", 1, 0],
    [
      "$ {a",
      "scriptlets (`$ statement`) are not supported in MX (decision 54)",
      1,
      0,
    ],
  ])("%j keeps main's error first", (source, message, line, column) => {
    expect(run(source)).toEqual({ message, line, column });
  });

  it.each(["div onClick(a", "div onClick(a) {b", "div x(a", "div async(a"])(
    "%j keeps main's attribute-method error first",
    (source) => {
      expect(run(source)?.message).toMatch(
        /^attribute method `[a-zA-Z]+\(\.\.\.\)` is an event handler/,
      );
    },
  );

  it.each([
    ["div<A", "the input ends inside `<`…`>` opened here", 1, 3],
    ["div x=`${a", "the input ends inside `` ` ``…`` ` `` opened here", 1, 6],
    ["div.a${b", "the input ends inside `${`…`}` opened here", 1, 5],
    ["script -- ${b", "the input ends inside `${`…`}` opened here", 1, 10],
    ["${x", "the input ends inside `${`…`}` opened here", 1, 0],
  ])(
    "%j, which main compiled, reports the new error",
    (source, message, line, column) => {
      expect(run(source)).toEqual({ message, line, column });
    },
  );
});
