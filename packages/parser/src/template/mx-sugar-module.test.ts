/**
 * The atoms-and-sugars syntax module against the built-in atoms and sugars
 * (`lang-ext-move-sugars-to-mesh`, slice a1): the atom corpora of
 * `mx-atoms.cases.ts` run through the module's rows (`test-support/
 * sugar-rows.ts`), their triggers rendered as the built-in events
 * (`test-support/sugar-module.ts`), with the same expectations, except the
 * rows of `mx-sugar-module.deltas.ts`. The after-value tables run in
 * `mx-after-value.test.ts`.
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
import { DELTAS, type SugarDelta } from "./mx-sugar-module.deltas.ts";
import { compileSyntax } from "./syntax.ts";
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

const BUILT_IN = template as unknown as AtomParserModule;
const BUILDS: [SugarDelta["build"], AtomParserModule][] = [
  ["atoms-row", sugarBuild(ATOMS_SYNTAX) as unknown as AtomParserModule],
  ["mesh-syntax", sugarBuild(MESH_SYNTAX) as unknown as AtomParserModule],
];

type Suite = Exclude<SugarDelta["suite"], "after-value">;
const SUITES: [Suite, [string, string][], boolean][] = [
  ["atoms", ATOMS, false],
  ["reserved", RESERVED, false],
  ["not-atoms", NOT_ATOMS, true],
  [
    "sugar-forms",
    SUGAR_FORMS.map((input) => [input, renderAtoms(BUILT_IN, input)]),
    false,
  ],
];

describe("the module rows", () => {
  it("validate, and turn the built-in paths off for their characters (the coexistence rule)", () => {
    for (const syntax of [ATOMS_SYNTAX, SUGARS_SYNTAX, MESH_SYNTAX]) {
      expect(template.validateSyntaxTable(syntax)).toEqual([]);
    }
    const flags = (syntax: template.SyntaxTable) => {
      const { builtInAtoms, builtInColonEnd, builtInPeriodEnd } =
        compileSyntax(syntax);
      return { builtInAtoms, builtInColonEnd, builtInPeriodEnd };
    };
    expect(flags(template.DEFAULT_SYNTAX)).toEqual({
      builtInAtoms: true,
      builtInColonEnd: true,
      builtInPeriodEnd: true,
    });
    expect(flags(ATOMS_SYNTAX)).toEqual({
      builtInAtoms: false,
      builtInColonEnd: true,
      builtInPeriodEnd: true,
    });
    expect(flags(MESH_SYNTAX)).toEqual({
      builtInAtoms: false,
      builtInColonEnd: false,
      builtInPeriodEnd: false,
    });
  });
});

describe.each(BUILDS)(
  "the atom corpora through the module (%s)",
  (build, mod) => {
    const deltaOf = (suite: Suite, input: string) =>
      DELTAS.find(
        (d) => d.build === build && d.suite === suite && d.input === input,
      );

    describe.each(SUITES)("%s", (suite, cases, statements) => {
      it.each(cases)("%j", (input, builtIn) => {
        expect(renderAtoms(BUILT_IN, input, statements)).toBe(builtIn);
        const delta = deltaOf(suite, input);
        if (delta) expect(delta.builtIn).toBe(builtIn);
        expect(renderAtoms(mod, input, statements)).toBe(
          delta ? delta.module : builtIn,
        );
      });
    });

    it("lists no stale delta: each names a corpus input and a real difference", () => {
      for (const delta of DELTAS) {
        if (delta.build !== build || delta.suite === "after-value") continue;
        const suite = SUITES.find(([name]) => name === delta.suite);
        expect(
          suite?.[1].some(([input]) => input === delta.input),
          delta.input,
        ).toBe(true);
        expect(delta.module).not.toBe(delta.builtIn);
      }
    });

    it("no TypeScript marker or type end is followed by an atom, at any depth", () => {
      const { bad } = tsMarkerViolations(mod, isValidTs);
      expect(bad).toEqual([]);
    });

    it("no non-ASCII operand or key before a TypeScript `:` is followed by an atom", () => {
      expect(nonAsciiMarkerViolations(mod, isValidTs).bad).toEqual([]);
    });

    it("comments, non-ASCII letters and Unicode whitespace lex as their twins", () => {
      expect(commentTwinMismatches(mod).bad).toEqual([]);
      expect(asciiTwinMismatches(mod).bad).toEqual([]);
      expect(unicodeWhitespaceLoopMismatches(mod).bad).toEqual([]);
      expect(unicodeWhitespaceMismatches(mod).bad).toEqual([]);
    });

    it("read() stands in the module's atoms as the built-in path does", () => {
      expect(readMismatches(mod)).toEqual([]);
      expect(rawOpenTagReads(mod)).toEqual(rawOpenTagReads(BUILT_IN));
      expect(tagNameReads(mod)).toEqual(tagNameReads(BUILT_IN));
    });
  },
);

/**
 * Item 5 of the a1 brief: for every static attribute-position sugar of the
 * corpora (`mx-after-value.test.ts`, `SUGAR_FORMS`, the front end's parse
 * and rules tests, core's name-sugar tests), the trigger's text is the
 * attribute-name extent the built-in lexer gives, so core's hook reads the
 * same token.
 */
const STATIC_SUGARS = [
  ":a",
  ":b:c",
  ":b.c",
  ":b%c",
  ":customer",
  ":isOverdue",
  ":T",
  ":x",
  "._b",
  ".$b",
  ".a.b",
  ".a@b",
  ".a+b",
  ".a|b",
  ".b:c",
  ".bg-[#fff]",
  ".c:bad%",
  ".c:n",
  ".c#m.d:y",
  ".c#m.d",
  ".é",
  ".w-1.5",
  ".w-1/2",
  "#1a",
  "#a-b_c$d",
  "#b:c",
  "#main",
  "::x",
  ":a::b",
];

describe("attribute sugar extents", () => {
  const names = (mod: AtomParserModule, code: string) => {
    const out: string[] = [];
    mod
      .createParser({
        onAttrName: (r: { start: number; end: number }) =>
          out.push(code.slice(r.start, r.end)),
        onError: (e: { message: string }) => out.push(`ERR ${e.message}`),
      })
      .parse(code);
    return out;
  };
  const mesh = sugarBuild(MESH_SYNTAX) as unknown as AtomParserModule;

  it.each(
    STATIC_SUGARS.flatMap((sugar) => [
      `<div ${sugar}/>`,
      `<div ${sugar} x=1/>`,
      `<div x=1 ${sugar}>`,
      `div ${sugar}\n`,
      `div x=1, ${sugar}, y\n`,
      `div [x=1 ${sugar}]\n`,
    ]),
  )("%j", (code) => {
    expect(names(mesh, code)).toEqual(names(BUILT_IN, code));
  });

  it("a sugar the rows do not match stays built-in: bare `:`, `.`, `#`, `:1a`, `.2xl`, `.-b`", () => {
    for (const sugar of [":", ".", "#", ":1a", ":é", ".2xl", ".-b"]) {
      const code = `<div ${sugar}/>`;
      expect(names(mesh, code), code).toEqual([sugar]);
    }
  });
});
