/**
 * Brief §1.2 E, the small run: both seeded generators, no throw, no internal
 * error, the span invariant on every tree. The long run (500,000+ inputs) is
 * `test-support/long-fuzz.ts`.
 */
import { describe, expect, it } from "vitest";
import { characters, run, tokens } from "./test-support/fuzz.ts";

describe("no-throw fuzz", () => {
  it("characters: 3,000 inputs from seed 1", () => {
    expect(run((s) => characters(s, 40), 1, 3000).failures).toEqual([]);
  });

  it("tokens: 3,000 inputs from seed 1", () => {
    expect(run(tokens, 1, 3000).failures).toEqual([]);
  });

  it("the generators are deterministic per seed", () => {
    expect(characters(7, 40)).toBe(characters(7, 40));
    expect(tokens(7)).toBe(tokens(7));
  });
});
