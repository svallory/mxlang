import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

/**
 * A `$` scriptlet is rejected everywhere; the fix depends on the host. An
 * `.astro.mx` template cannot declare a binding (`<const>` is rejected), so
 * the hint points at the `---` fence (audit item 14, fix-hints round 2).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
const ANSI = /\x1b\[[0-9;]*m/g;

function message(source: string): string {
  try {
    lowerAstroMx(source, "Test.astro.mx");
  } catch (error) {
    return (error as Error).message.replace(ANSI, "");
  }
  throw new Error("expected a compile error, but the template compiled");
}

describe("scriptlets (astro)", () => {
  it("points at the fence, not at <const>", () => {
    expect(message("---\n---\n$ const y = 1;\n<p>${y}</p>")).toBe(
      "scriptlets (`$ statement`) are not supported in MX (decision 54); declare it in the `---` fence (`const y = …;`)",
    );
  });

  it("the form it suggests compiles", () => {
    expect(() =>
      lowerAstroMx("---\nconst y = 1;\n---\n<p>${y}</p>", "Test.astro.mx"),
    ).not.toThrow();
  });

  it("a statement that declares nothing gets the bare sentence", () => {
    expect(message("---\n---\n$ doThing();\n<p>1</p>")).toBe(
      "scriptlets (`$ statement`) are not supported in MX (decision 54)",
    );
  });
});
