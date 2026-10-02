import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

/**
 * A duplicate attribute (`<div class="a" class="b">`) is a positioned
 * warning, never an error. Stock Marko 6.3.51 accepts it silently; the
 * emitted attributes stay exactly as authored on every host.
 */
interface Warning {
  message: string;
  line: number;
  column: number;
  file?: string;
}

function run(source: string) {
  const warnings: Warning[] = [];
  const result = lowerAstroMx(`---\nconst x = 1;\n---\n${source}`, "Test.amx", {
    warnings,
  });
  return { code: result.code, warnings };
}

const MESSAGE = (name: string, line: number, column: number) =>
  `duplicate attribute \`${name}\`: also written at ${line}:${column + 1}; keep one, because which value wins depends on the target`;

describe("duplicate attributes (astro)", () => {
  it("warns once at the second occurrence, naming both positions", () => {
    const { code, warnings } = run('<div class="a" class="b">hi</div>');
    expect(warnings).toEqual([
      {
        message: MESSAGE("class", 4, 5),
        line: 4,
        column: 15,
        file: "Test.amx",
      },
    ]);
    // Output is unchanged: both attributes are still emitted as authored.
    expect(code).toContain('class="a" class="b"');
  });

  it("warns per repeated name, on the right lines", () => {
    const { warnings } = run(
      '<div id="a"\n  id="b" title="t" title="u">hi</div>',
    );
    expect(warnings.map((w) => [w.message, w.line, w.column])).toEqual([
      [MESSAGE("id", 4, 5), 5, 2],
      [MESSAGE("title", 5, 9), 5, 19],
    ]);
  });

  it("counts columns in UTF-16 code units after non-ASCII text", () => {
    // `é` is one unit, the emoji two: the second `title` is at column 15.
    const { warnings } = run('<p title="é😀" title="b"/>');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: MESSAGE("title", 4, 3),
      line: 4,
      column: 15,
    });
  });

  it("a third occurrence warns against the one before it", () => {
    const { warnings } = run('<div class="a" class="b" class="c"/>');
    expect(warnings.map((w) => [w.message, w.column])).toEqual([
      [MESSAGE("class", 4, 5), 15],
      [MESSAGE("class", 4, 15), 25],
    ]);
  });

  it("stays silent for distinct names, other tags and case differences", () => {
    expect(run('<div class="a" id="b">x</div>').warnings).toEqual([]);
    expect(
      run('<div class="a"><span class="b">x</span></div>').warnings,
    ).toEqual([]);
    // Names compare case-sensitively, as Marko's do.
    expect(run('<div data-a="1" data-A="2">x</div>').warnings).toEqual([]);
  });

  it("stays silent for a spread next to an explicit attribute", () => {
    expect(run('<div class="a" ...input.rest>x</div>').warnings).toEqual([]);
  });
});
