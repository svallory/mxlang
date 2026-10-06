/**
 * Atom lexing (decision 156) against this source copy. The cases live in
 * `mx-atoms.cases.ts`; `patches/htmljs-parser.test.ts` runs the same table
 * against the patched npm build.
 */
import { describe, expect, it } from "vitest";
import { parseBabelExpression } from "../index.ts";
import * as template from "./index.ts";
import {
  ATOMS,
  type AtomParserModule,
  asciiTwinMismatches,
  NOT_ATOMS,
  nonAsciiMarkerViolations,
  parseScaling,
  RESERVED,
  rawOpenTagReads,
  readMismatches,
  renderAtoms,
  SUGAR_FORMS,
  tagNameReads,
  tsMarkerViolations,
  unicodeWhitespaceMismatches,
} from "./mx-atoms.cases.ts";

const isValidTs = (expression: string) => {
  try {
    parseBabelExpression(expression, { plugins: ["typescript"] });
    return true;
  } catch {
    return false;
  }
};

const mod = template as unknown as AtomParserModule;

describe("atoms (src/template)", () => {
  it.each(ATOMS)("atom: %j", (input, expected) => {
    expect(renderAtoms(mod, input)).toBe(expected);
  });

  it.each(RESERVED)("reserved: %j", (input, expected) => {
    expect(renderAtoms(mod, input)).toBe(expected);
  });

  it("a raw open-tag read is the source; the value keeps its stand-in", () => {
    expect(rawOpenTagReads(mod)).toEqual({ raw: "style x=:a", value: "0." });
  });

  it("a mixed tag name reads its stand-in; only the raw open tag reads the source", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX source, not a JS template
    const expected = { name: "foo-${0.}", raw: "foo-${:a} x=:b" };
    expect(tagNameReads(mod)).toEqual(expected);
  });

  it("no TypeScript marker or type end is followed by an atom, at any depth", () => {
    const { total, ran, bad } = tsMarkerViolations(mod, isValidTs);
    expect(total).toBe(11_520);
    expect(ran).toBeGreaterThan(9_000);
    expect(bad).toEqual([]);
  });

  it("no non-ASCII operand or key before a TypeScript `:` is followed by an atom", () => {
    const { total, ran, bad } = nonAsciiMarkerViolations(mod, isValidTs);
    expect(total).toBe(21_840);
    expect(ran).toBeGreaterThan(14_000);
    expect(bad).toEqual([]);
  });

  it("a non-ASCII letter before `:` lexes as the same row with an ASCII letter", () => {
    const { total, bad } = asciiTwinMismatches(mod);
    expect(total).toBe(5_040);
    expect(bad).toEqual([]);
  });

  it("Unicode whitespace before `:` lexes as main did (review F1)", () => {
    const { total, bad } = unicodeWhitespaceMismatches(mod);
    expect(total).toBe(2_660);
    expect(bad).toEqual([]);
  });

  it("parse time grows linearly with the file (no scan to the end of file)", () => {
    // 32x the input: linear ~32, the end-of-file scan ~1,000 (see
    // parseScaling).
    expect(parseScaling(mod)).toBeLessThan(200);
  }, 60_000);

  it("read()'s binary search agrees with a linear stand-in on every range", () => {
    expect(readMismatches(mod)).toEqual([]);
  });

  it.each(NOT_ATOMS)("not an atom: %j", (input, expected) => {
    expect(renderAtoms(mod, input, true)).toBe(expected);
  });

  it.each(SUGAR_FORMS)("decision 146 form lexes no atom: %j", (input) => {
    expect(renderAtoms(mod, input)).not.toMatch(/atom\(|is reserved/);
  });

  it("read() stands in every atom fully inside the range", () => {
    const code = "<div x=:a y=:bb/>";
    const parser = template.createParser({});
    parser.parse(code);
    expect(parser.read({ start: 0, end: code.length })).toBe(
      "<div x=0. y=0.0/>",
    );
    // A range that only partly covers an atom reads the source.
    expect(parser.read({ start: 8, end: 9 })).toBe("a");
    expect(parser.read({ start: 0, end: 8 })).toBe("<div x=:");
  });

  it("a reused parser forgets the previous parse's atoms", () => {
    const parser = template.createParser({});
    parser.parse("<div x=:a/>");
    parser.parse("<div x=1a/>");
    expect(parser.read({ start: 7, end: 9 })).toBe("1a");
  });

  it("onAtom hands the atom span and its name span", () => {
    const seen: unknown[] = [];
    template
      .createParser({ onAtom: (a) => seen.push(a) })
      .parse("<div x=[:a, :rename-all]/>");
    expect(seen).toEqual([
      { start: 8, end: 10, value: { start: 9, end: 10 } },
      { start: 12, end: 23, value: { start: 13, end: 23 } },
    ]);
  });
});
