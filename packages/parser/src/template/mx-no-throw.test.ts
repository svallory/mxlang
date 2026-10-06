/**
 * template-parser-comment-in-text-tag-open-crash against this source copy.
 * The cases live in `mx-no-throw.cases.ts`; `patches/htmljs-parser.test.ts`
 * runs the same table against the patched npm build.
 */
import { describe, expect, it } from "vitest";
import * as template from "./index.ts";
import {
  fuzzThrows,
  NO_THROW_ROWS,
  type NoThrowParserModule,
  renderEvents,
} from "./mx-no-throw.cases.ts";

const mod = template as unknown as NoThrowParserModule;

describe("the template parser never throws (src/template)", () => {
  it.each(NO_THROW_ROWS)("%j", (input, expected) => {
    expect(renderEvents(mod, input)).toBe(expected);
  });

  it("no generated input from the delimiter alphabet throws (seed 1)", () => {
    expect(fuzzThrows(mod, 1, 5_000)).toEqual({ total: 5_000, thrown: [] });
  });
});
