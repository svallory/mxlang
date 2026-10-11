/**
 * Atoms as a dialect builds them: the atom corpora of `mx-atoms.cases.ts`
 * through the `:` expression row (`test-support/sugar-rows.ts`,
 * `ATOMS_SYNTAX`), its triggers rendered as plain events
 * (`test-support/sugar-module.ts`). The template parser lexes no atom of its
 * own; the default row reads every one of these inputs as stock Marko does
 * (the `colon-*` and `double-colon-*` rows of
 * `packages/stock-marko/src/divergence.cases.ts`, and
 * `packages/core/src/stock-colon.test.ts` for the compile errors).
 */

import { parseExpression as parseBabelExpression } from "@mxlang/babel";
import { describe, expect, it } from "vitest";
import * as template from "./index.ts";
import {
  ATOMS,
  type AtomParserModule,
  asciiTwinMismatches,
  commentTwinMismatches,
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
  unicodeWhitespaceLoopMismatches,
  unicodeWhitespaceMismatches,
} from "./mx-atoms.cases.ts";
import { sugarBuild } from "./test-support/sugar-module.ts";
import {
  ATOMS_SYNTAX,
  MESH_SYNTAX,
  SUGARS_SYNTAX,
} from "./test-support/sugar-rows.ts";

const isValidTs = (expression: string) => {
  try {
    parseBabelExpression(expression, { plugins: ["typescript"] });
    return true;
  } catch {
    return false;
  }
};

const DEFAULT = template as unknown as AtomParserModule;
const mod = sugarBuild(ATOMS_SYNTAX) as unknown as AtomParserModule;

/**
 * Attribute forms the corpora lack (review 460 r1): a value after `:=`,
 * `(args)` with no body, and `async` before a method. The atom row arms in
 * expressions only, so a `:name` attribute is stock's attribute name.
 */
const MODULE_FORMS: [string, string][] = [
  ["<x :n:=y/>", '<x> @:n ="y"'],
  ["<x :n := y/>", '<x> @:n ="y"'],
  ["div :n:=a.b c", '<div> @:n ="a.b" @c'],
  ["<x :a(p)/>", '<x> @:a aargs:"p"'],
  ["<x :a(:p)/>", '<x> @:a atom(p@6-8) aargs:"0."'],
  ["div :b(x) y", '<div> @:b aargs:"x" @y'],
  ["<x :a(p)=1/>", '<x> @:a aargs:"p" ="1"'],
  ["<x :a(p) := q/>", '<x> @:a aargs:"p" ="q"'],
  ["<x :n(p) { b }/>", '<x> @:n method:" b "'],
  ["<x async :n(p) { b }/>", '<x> @async @:n method:" b "'],
  ["<x #i:=y/>", '<x> @#i ="y"'],
  ["<x .c(p)/>", '<x> @.c aargs:"p"'],
];

describe("the module rows", () => {
  it("validate", () => {
    for (const syntax of [ATOMS_SYNTAX, SUGARS_SYNTAX, MESH_SYNTAX]) {
      expect(template.validateSyntaxTable(syntax)).toEqual([]);
    }
  });
});

describe("the atom corpora through the atom row", () => {
  it.each(ATOMS)("atom: %j", (input, expected) => {
    expect(renderAtoms(mod, input)).toBe(expected);
  });

  it.each(RESERVED)("reserved: %j", (input, expected) => {
    expect(renderAtoms(mod, input)).toBe(expected);
  });

  it.each(NOT_ATOMS)("not an atom: %j", (input, expected) => {
    expect(renderAtoms(mod, input, true)).toBe(expected);
  });

  it.each(SUGAR_FORMS)(
    "a name-sugar form lexes no atom, as the default row reads it: %j",
    (input) => {
      const rendered = renderAtoms(mod, input);
      expect(rendered).not.toMatch(/atom\(|is reserved/);
      expect(rendered).toBe(renderAtoms(DEFAULT, input));
    },
  );

  it.each(MODULE_FORMS)("attribute form: %j", (input, expected) => {
    expect(renderAtoms(mod, input)).toBe(expected);
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

  it("a comment around an operator word lexes as whitespace does", () => {
    const { total, bad } = commentTwinMismatches(mod);
    expect(total).toBe(312);
    expect(bad).toEqual([]);
  });

  it("a non-ASCII letter before `:` lexes as the same row with an ASCII letter", () => {
    const { total, bad } = asciiTwinMismatches(mod);
    expect(total).toBe(5_040);
    expect(bad).toEqual([]);
  });

  it("Unicode whitespace in the trigger look-behind lexes as an ASCII space", () => {
    const { total, bad } = unicodeWhitespaceLoopMismatches(mod);
    expect(total).toBe(1_482);
    expect(bad).toEqual([]);
  });

  it("Unicode whitespace before `:` lexes as an ASCII space", () => {
    const { total, bad } = unicodeWhitespaceMismatches(mod);
    expect(total).toBe(2_660);
    expect(bad).toEqual([]);
  });

  it("read() stands in every atom fully inside the range", () => {
    expect(readMismatches(mod)).toEqual([]);
  });

  it("a raw open-tag read is the source; the value keeps its stand-in", () => {
    expect(rawOpenTagReads(mod)).toEqual({ raw: "style x=:a", value: "0." });
  });

  it("a mixed tag name reads its stand-in; only the raw open tag reads the source", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: MX source, not a JS template
    const expected = { name: "foo-${0.}", raw: "foo-${:a} x=:b" };
    expect(tagNameReads(mod)).toEqual(expected);
  });
});

describe("the default row", () => {
  it("parse time grows linearly with the file (no scan to the end of file)", () => {
    // 32x the input: linear ~32, the end-of-file scan ~1,000 (see
    // parseScaling).
    expect(parseScaling(DEFAULT)).toBeLessThan(200);
  }, 60_000);
});
