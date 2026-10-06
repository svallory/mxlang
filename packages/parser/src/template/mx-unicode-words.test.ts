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
  asciiMainMismatches,
  BODY_TEXT_ROWS,
  bodyTextTwinMismatches,
  CONCISE_DASH_ROWS,
  renderAttrRanges,
  renderWhitespaceEvents,
  UNICODE_WHITESPACE_ROWS,
  UNICODE_WORD_ROWS,
  unicodeWhitespaceTwinMismatches,
  unicodeWordTwinMismatches,
} from "./mx-unicode-words.cases.ts";

const mod = template as unknown as AtomParserModule;
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
    "Unicode whitespace in a look-behind (addendum 11): %j",
    (input, expected) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(expected);
    },
  );

  it.each(CONCISE_DASH_ROWS)(
    "concise `--` after Unicode whitespace (addendum 12): %j",
    (input, events, ranges) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(events);
      expect(renderAttrRanges(mod, input)).toBe(ranges);
    },
  );

  it("Unicode whitespace in a look-behind renders as an ASCII space (addendum 11)", () => {
    const { total, bad } = unicodeWhitespaceTwinMismatches(wsMod);
    expect(total).toBe(2_432);
    expect(bad).toEqual([]);
  });

  it.each(BODY_TEXT_ROWS)(
    "body text before `//` is text after Unicode whitespace (addendum 13): %j",
    (input, expected) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(expected);
    },
  );

  it("body text after Unicode whitespace renders as after a letter (addendum 13)", () => {
    const { total, bad } = bodyTextTwinMismatches(wsMod);
    expect(total).toBe(114);
    expect(bad).toEqual([]);
  });
});
