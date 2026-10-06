/**
 * template-parser-ascii-only-lookbehinds against this source copy. The cases
 * live in `mx-unicode-words.cases.ts`; `patches/htmljs-parser.test.ts` runs
 * the same table against the patched npm build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as template from "./index.ts";
import { type AtomParserModule, renderAtoms } from "./mx-atoms.cases.ts";
import {
  asciiMainMismatches,
  UNICODE_WORD_ROWS,
  unicodeWordTwinMismatches,
} from "./mx-unicode-words.cases.ts";

const mod = template as unknown as AtomParserModule;
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
});
