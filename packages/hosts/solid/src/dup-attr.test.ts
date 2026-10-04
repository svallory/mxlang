import { describe, expect, it } from "vitest";
import { compileSolidMx } from "./index.ts";

/**
 * A duplicate attribute (`<div class="a" class="b">`) resolves last-wins in
 * core, like stock Marko 6.3.51 (decision 135): the earlier occurrence is
 * dropped from the output and gets a positioned warning naming the survivor.
 * Never an error. The structured position is core's 0-based column; the
 * message text is 1-based.
 */
interface Warning {
  message: string;
  line: number;
  column: number;
  file?: string;
}

function run(source: string) {
  const warnings: Warning[] = [];
  const result = compileSolidMx(source, {
    filename: "fixture.solid.mx",
    warnings,
  });
  return { code: result.code, warnings };
}

/** `line`/`column` locate the SURVIVOR (column 0-based, like the warning). */
const MESSAGE = (name: string, line: number, column: number) =>
  `duplicate attribute \`${name}\`: the later one at ${line}:${column + 1} wins, so this one is dropped`;

describe("duplicate attributes (solid)", () => {
  it("warns once at the dropped occurrence, naming the survivor", () => {
    const { code, warnings } = run('<div class="a" class="b">hi</div>');
    expect(warnings).toEqual([
      {
        message: MESSAGE("class", 1, 15),
        line: 1,
        column: 5,
        file: "fixture.solid.mx",
      },
    ]);
    // Only the survivor is emitted.
    expect(code).toContain('class="b"');
    expect(code).not.toContain('class="a"');
  });

  it("warns per repeated name, on the right lines", () => {
    const { warnings } = run(
      '<div id="a"\n  id="b" title="t" title="u">hi</div>',
    );
    expect(warnings.map((w) => [w.message, w.line, w.column])).toEqual([
      [MESSAGE("id", 2, 2), 1, 5],
      [MESSAGE("title", 2, 19), 2, 9],
    ]);
  });

  it("counts columns in UTF-16 code units after non-ASCII text", () => {
    // `é` is one unit, the emoji two: the surviving `title` is at column 15.
    const { warnings } = run('<p title="é😀" title="b"/>');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: MESSAGE("title", 1, 15),
      line: 1,
      column: 3,
    });
  });

  it("a third occurrence: each dropped one warns, naming the last", () => {
    const { warnings } = run('<div class="a" class="b" class="c"/>');
    expect(warnings.map((w) => [w.message, w.column])).toEqual([
      [MESSAGE("class", 1, 25), 5],
      [MESSAGE("class", 1, 25), 15],
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

  it("warns for a handler written twice (the first is dropped), not for two spellings", () => {
    const { warnings } = run("<button on-click=fn on-click=fn2>x</button>");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      message: MESSAGE("on-click", 1, 20),
      line: 1,
      column: 8,
    });
    expect(run("<button onClick=fn on-click=fn2>x</button>").warnings).toEqual(
      [],
    );
  });

  it("keeps the survivor at its own position, as Marko does", () => {
    // Marko: `<div class="a" id="x" class="b">` -> `<div id=x class=b>`.
    const { code, warnings } = run('<div class="a" id="x" class="b">hi</div>');
    expect(code).toContain('id="x" class="b"');
    expect(code).not.toContain('class="a"');
    expect(warnings).toHaveLength(1);
  });

  it("drops the earlier one even with a spread between them", () => {
    // `a=2` already won over the spread's `a`; the dead `a=1` is dropped.
    const { code, warnings } = run('<div a="1" ...input.rest a="2">x</div>');
    expect(code).toContain('a="2"');
    expect(code).not.toContain('a="1"');
    expect(warnings.map((w) => [w.message, w.line, w.column])).toEqual([
      [MESSAGE("a", 1, 25), 1, 5],
    ]);
  });

  it("does not warn or drop for a lone attribute before a spread", () => {
    const { code, warnings } = run('<div a="1" ...input.rest>x</div>');
    expect(warnings).toEqual([]);
    expect(code).toContain('a="1"');
  });
});
