/**
 * Atom lexing (decision 156) against this source copy. The cases live in
 * `mx-atoms.cases.ts`; `patches/htmljs-parser.test.ts` runs the same table
 * against the patched npm build.
 */
import { describe, expect, it } from "vitest";
import * as template from "./index.ts";
import {
  ATOMS,
  type AtomParserModule,
  NOT_ATOMS,
  RESERVED,
  rawOpenTagReads,
  readMismatches,
  renderAtoms,
  SUGAR_FORMS,
} from "./mx-atoms.cases.ts";

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
