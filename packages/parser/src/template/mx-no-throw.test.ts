/**
 * template-parser-comment-in-text-tag-open-crash against this source copy.
 * The cases live in `mx-no-throw.cases.ts`; `patches/htmljs-parser.test.ts`
 * runs the same table against the patched npm build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as template from "./index.ts";
import {
  fuzzLineThrows,
  fuzzNamelessThrows,
  fuzzThrows,
  NAMELESS_TAG_ROWS,
  NO_THROW_ROWS,
  type NoThrowParserModule,
  namelessAsciiMismatches,
  renderErrorCodes,
  renderEvents,
  STRAY_CLOSE_ROWS,
} from "./mx-no-throw.cases.ts";

const mod = template as unknown as NoThrowParserModule;
const namelessMain = JSON.parse(
  readFileSync(
    new URL("./mx-nameless-ascii.main.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>;

describe("the template parser never throws (src/template)", () => {
  it.each(NO_THROW_ROWS)("%j", (input, expected) => {
    expect(renderEvents(mod, input)).toBe(expected);
  });

  it("no generated input from the delimiter alphabet throws (seed 1)", () => {
    expect(fuzzThrows(mod, 1, 5_000)).toEqual({ total: 5_000, thrown: [] });
  });

  it.each(STRAY_CLOSE_ROWS)(
    "a stray closing tag after a nameless tag: %j",
    (input, events, codes) => {
      expect(renderEvents(mod, input)).toBe(events);
      expect(renderErrorCodes(mod, input)).toBe(codes);
    },
  );

  it("no generated concise-line input throws (seed 1)", () => {
    expect(fuzzLineThrows(mod, 1, 5_000)).toEqual({
      total: 5_000,
      thrown: [],
    });
  });

  it.each(NAMELESS_TAG_ROWS)(
    "a tag that never got its name never throws: %j",
    (input, expected) => {
      expect(renderEvents(mod, input)).toBe(expected);
      expect(renderErrorCodes(mod, input).includes("THROW")).toBe(false);
    },
  );

  it("ASCII nameless and empty-name tags render as main did", () => {
    const { total, bad } = namelessAsciiMismatches(mod, namelessMain);
    expect(total).toBe(2_903);
    expect(bad).toEqual([]);
  });

  it("no generated nameless-tag input throws (seeds 1 and 2)", () => {
    for (const seed of [1, 2]) {
      expect(fuzzNamelessThrows(mod, seed, 20_000)).toEqual({
        total: 20_000,
        thrown: [],
      });
    }
  });
});
