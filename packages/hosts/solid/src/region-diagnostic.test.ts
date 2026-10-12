import { parse as parseMxFile } from "@mxlang/tsx-bridge";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * A lowering error inside a region reaches the author as the parser's
 * positioned error. It carries the MX code and the exclusive end of the range
 * the lowering reported, so a tool shows `MX_*` and the whole range instead of
 * `TS80001` and one character.
 */
const file = (body: string) =>
  `export function App() {\n  return (\n    ${body}\n  );\n}\n`;

interface Raised {
  message: string;
  loc: { line: number; column: number; end?: { line: number; column: number } };
  diagnosticCode?: string;
  end?: { line: number; column: number };
}

function raisedBy(source: string): Raised {
  try {
    parseMxFile(source, "fixture.solid.mx", {
      // biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
      mxRegionCompile: ((input: any) =>
        compileSolidMx(input.source, input)) as any,
    });
  } catch (error) {
    return error as Raised;
  }
  throw new Error("expected a compile error, but the file compiled");
}

describe("solid region: a lowering error carries its code and end", () => {
  it("a `<for>` without parameters: MX_INVALID_FOR over the tag name", () => {
    const raised = raisedBy(file("<for|x|/>"));
    expect(raised.diagnosticCode).toBe("MX_INVALID_FOR");
    // The region starts at 3:4 (`<for`, four characters).
    expect(raised.loc).toMatchObject({ line: 3, column: 4 });
    expect(raised.end).toEqual({ line: 3, column: 8 });
    expect(raised.loc.end).toEqual({ line: 3, column: 8 });
  });

  it("an undeclared colon tag: the range covers the name, no code", () => {
    const raised = raisedBy(file("<ns:tag/>"));
    expect(raised.message).toContain("Unable to find entry point");
    expect(raised.loc).toMatchObject({ line: 3, column: 4 });
    expect(raised.end).toEqual({ line: 3, column: 11 });
    expect(raised.diagnosticCode).toBeUndefined();
  });

  it("a second line of the region keeps file-absolute coordinates", () => {
    const raised = raisedBy(file("<div>\n      <ns:tag/>\n    </div>"));
    expect(raised.loc).toMatchObject({ line: 4, column: 6 });
    expect(raised.end).toEqual({ line: 4, column: 13 });
  });
});
