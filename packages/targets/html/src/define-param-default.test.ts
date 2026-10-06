import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

/**
 * An empty default in a destructured tag param (`<define/Foo|{a=}|>`) threw
 * Marko's `CompileError` at 0:0 with a message that opens with an empty line;
 * it is a positioned error at the param with Babel's reason.
 */
function run(source: string): unknown {
  try {
    compile(source, "a.mx");
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("a tag param Babel cannot read", () => {
  it.each([
    ["<define/Foo|{a=}|><b/></define>\n<Foo/>", 1, 15],
    ["<define/Foo|{a=}|/>", 1, 15],
    ["<div>\n  <define/Foo|{a=}|/>\n</div>", 2, 17],
    ["<for|{a=}| of=x><b/></for>", 1, 8],
  ])("%j is positioned at the param", (source, line, column) => {
    expect(run(source)).toMatchObject({
      message: "Unexpected token",
      line,
      column,
    });
  });

  it("still compiles a param with a default value", () => {
    expect(run("<define/Foo|{a = 1}|><b/></define>\n<Foo/>")).toBeUndefined();
  });
});
