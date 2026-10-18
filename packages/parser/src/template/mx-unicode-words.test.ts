/**
 * template-parser-ascii-only-lookbehinds against this source copy. The cases
 * live in `mx-unicode-words.cases.ts`; `patches/htmljs-parser.test.ts` runs
 * the same table against the patched npm build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as template from "./index.ts";
import { type AtomParserModule, renderAtoms } from "./mx-atoms.cases.ts";
import type { NoThrowParserModule } from "./mx-no-throw.cases.ts";
import {
  AFTER_VALUE_ON_HOLD_ROWS,
  ATOM_AFTER_SYMBOL_ROWS,
  asciiMainMismatches,
  atomAfterSymbolMismatch,
  BODY_TEXT_ROWS,
  bodyTextTwinMismatches,
  CONCISE_DASH_ROWS,
  extraWordTwinMismatches,
  NON_WORD_ROWS,
  nonWordTwinMismatches,
  renderAttrRanges,
  renderWhitespaceEvents,
  UNICODE_WHITESPACE_ROWS,
  UNICODE_WORD_ROWS,
  unicodeWhitespaceTwinMismatches,
  unicodeWordTwinMismatches,
} from "./mx-unicode-words.cases.ts";
import { sugarBuild } from "./test-support/sugar-module.ts";
import { ATOMS_SYNTAX } from "./test-support/sugar-rows.ts";

const mod = template as unknown as AtomParserModule;
/** The atom row's build: the template parser lexes no atom of its own. */
const atomRow = sugarBuild(ATOMS_SYNTAX) as unknown as AtomParserModule;
const wsMod = template as unknown as AtomParserModule & NoThrowParserModule;
const main = JSON.parse(
  readFileSync(
    new URL("./mx-unicode-words.main.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>;

describe("non-ASCII identifiers in look-behinds and look-aheads (src/template)", () => {
  it.each(UNICODE_WORD_ROWS)("%j", (input, expected) => {
    expect(renderAtoms(mod, input, true)).toBe(expected);
  });

  it("each non-ASCII input renders as its ASCII twin", () => {
    const { total, bad } = unicodeWordTwinMismatches(mod);
    expect(total).toBe(5_994);
    expect(bad).toEqual([]);
  });

  it("ASCII-only input renders as main did", () => {
    const { total, bad } = asciiMainMismatches(mod, main);
    expect(total).toBe(983);
    expect(bad).toEqual([]);
  });

  it.each(UNICODE_WHITESPACE_ROWS)(
    "Unicode whitespace in a look-behind: %j",
    (input, expected) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(expected);
    },
  );

  it.each(CONCISE_DASH_ROWS)(
    "concise `--` after Unicode whitespace: %j",
    (input, events, ranges) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(events);
      expect(renderAttrRanges(mod, input)).toBe(ranges);
    },
  );

  it("Unicode whitespace in a look-behind renders as an ASCII space", () => {
    const { total, bad } = unicodeWhitespaceTwinMismatches(wsMod);
    expect(total).toBe(2_432);
    expect(bad).toEqual([]);
  });

  it.each(AFTER_VALUE_ON_HOLD_ROWS)(
    "the after-value identifier start is ASCII, on hold: %j",
    (input, expected) => {
      expect(renderAtoms(mod, input, true)).toBe(expected);
    },
  );

  it.each(NON_WORD_ROWS)(
    "a symbol is no word character, as in stock: %j",
    (input, expected) => {
      expect(renderAtoms(mod, input, true)).toBe(expected);
    },
  );

  it.each(ATOM_AFTER_SYMBOL_ROWS)(
    "the atom row arms after a symbol, as after ASCII punctuation: %j",
    (input, twin, expected) => {
      expect(atomAfterSymbolMismatch(atomRow, [input, twin, expected])).toEqual(
        [],
      );
    },
  );

  it("a symbol renders as an ASCII non-word", () => {
    const { total, bad } = nonWordTwinMismatches(mod);
    expect(total).toBe(6_660);
    expect(bad).toEqual([]);
  });

  it("an identifier character renders as an ASCII letter", () => {
    const { total, bad } = extraWordTwinMismatches(mod);
    expect(total).toBe(4_662);
    expect(bad).toEqual([]);
  });

  it.each(BODY_TEXT_ROWS)(
    "body text before `//` is text after Unicode whitespace: %j",
    (input, expected) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(expected);
    },
  );

  it("body text after Unicode whitespace renders as after a letter", () => {
    const { total, bad } = bodyTextTwinMismatches(wsMod);
    expect(total).toBe(114);
    expect(bad).toEqual([]);
  });
});
