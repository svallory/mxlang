import { parse as parseMxFile } from "@mxlang/parser";
import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * Marko's own errors say what is wrong, not what to write (audit item 14,
 * cases s10/s07). MX appends one fix hint, in place; every suggested fix is
 * compiled here. Compiled as a whole `.solid.mx` file, the way every
 * integration does; the parser appends ` (line:column)` to a region's message.
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

function message(source: string): string {
  try {
    compileFile(source);
  } catch (error) {
    return (error as Error).message.replace(ANSI, "");
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("event binding syntax (solid)", () => {
  it("s10: names the Marko handler attribute", () => {
    expect(message(file('<button (click)="go()">x</button>'))).toBe(
      "tag arguments `(...)` on `<button>` are not supported in a standalone template; for an event handler write `onClick=go`",
    );
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
      expect(
        message(file(`<div>\n      $ ${keyword} y = 1;\n    </div>`)),
      ).toBe(
        `scriptlets (\`$ statement\`) are not supported in MX (decision 54); declare it in the surrounding TypeScript module (\`${keyword} y = …;\`)`,
      );
      expect(() =>
        compileFile(`${keyword} y = 1;\ny = 2;\n${file(`<p>\${y}</p>`)}`),
      ).not.toThrow();
    },
  );

  it("s07: says what to write instead", () => {
    expect(message(file("<div>\n      $ const y = ;\n    </div>"))).toBe(
      "scriptlets (`$ statement`) are not supported in MX (decision 54); declare it in the surrounding TypeScript module (`const y = …;`)",
    );
  });
});
