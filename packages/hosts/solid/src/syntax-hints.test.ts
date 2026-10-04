import { parse as parseMxFile } from "@mxlang/parser";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * Marko's own errors say what is wrong, not what to write (audit item 14,
 * cases s10/s07). MX appends one fix hint, in place; every suggested fix is
 * compiled here. Compiled as a whole `.solid.mx` file, the way every
 * integration does. A region's message carries no `(L:C)` any more (a
 * printed position is 1-based, ruling #227, and this one lives on `loc`), so
 * each row asserts the text and the position separately.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

const file = (body: string) =>
  `export function App() {\n  return (\n    ${body}\n  );\n}\n`;

function compileFile(source: string): void {
  const regionCompile = (
    input: Parameters<typeof compileSolidMx>[1] & { source: string },
  ) => compileSolidMx(input.source, input);
  parseMxFile(source, "fixture.solid.mx", {
    // biome-ignore lint/suspicious/noExplicitAny: MxRegionCompile shape, avoiding a parser<->solid type cycle in a test
    mxRegionCompile: regionCompile as any,
  });
}

/**
 * The error a compile raised, as its text plus the parser's own `loc`
 * (1-based line, 0-based column). Both are asserted, because the text alone
 * no longer carries the position.
 */
function message(source: string): {
  message: string;
  loc?: { line: number; column: number };
} {
  try {
    compileFile(source);
  } catch (error) {
    const e = error as Error & { loc?: { line: number; column: number } };
    return { message: e.message.replace(ANSI, ""), loc: e.loc };
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("event binding syntax (solid)", () => {
  it("s10: names the Marko handler attribute", () => {
    const raised = message(file('<button (click)="go()">x</button>'));
    expect(raised.message).toBe(
      "tag arguments `(...)` on `<button>` are not supported in a standalone template; for an event handler write `onClick=go`",
    );
    expect(raised.message).not.toMatch(/\(\d+:\d+\)$/);
    expect(raised.loc).toMatchObject({ line: 3, column: 4 });
  });

  it("the handler form it suggests compiles", () => {
    expect(() =>
      compileFile(file("<button onClick=go>x</button>")),
    ).not.toThrow();
  });
});

describe("scriptlets (solid)", () => {
  it("the form it suggests compiles", () => {
    expect(() =>
      compileFile(
        "const y = 1;\nexport function App() {\n  return (\n    <div>{y}</div>\n  );\n}\n",
      ),
    ).not.toThrow();
  });

  it.each(["let", "var"])(
    "preserves the %s keyword in the module advice",
    (keyword) => {
      const raised = message(
        file(`<div>\n      $ ${keyword} y = 1;\n    </div>`),
      );
      expect(raised.message).toBe(
        `scriptlets (\`$ statement\`) are not supported in MX (decision 54); declare it in the surrounding TypeScript module (\`${keyword} y = …;\`)`,
      );
      expect(raised.message).not.toMatch(/\(\d+:\d+\)$/);
      expect(raised.loc).toMatchObject({ line: 4, column: 6 });
      expect(() =>
        compileFile(`${keyword} y = 1;\ny = 2;\n${file(`<p>\${y}</p>`)}`),
      ).not.toThrow();
    },
  );

  it("s07: says what to write instead", () => {
    const raised = message(file("<div>\n      $ const y = ;\n    </div>"));
    expect(raised.message).toBe(
      "scriptlets (`$ statement`) are not supported in MX (decision 54); declare it in the surrounding TypeScript module (`const y = …;`)",
    );
    expect(raised.message).not.toMatch(/\(\d+:\d+\)$/);
    expect(raised.loc).toMatchObject({ line: 4, column: 6 });
  });
});
