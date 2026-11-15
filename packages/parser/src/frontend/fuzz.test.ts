/**
 * Brief §1.2 E, the small run: both seeded generators, no throw, no internal
 * error, the span invariant on every tree. The long run (500,000+ inputs) is
 * `test-support/long-fuzz.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { seams } from "./parse.ts";
import {
  characters,
  expressionHeavy,
  run,
  tokens,
} from "./test-support/fuzz.ts";

const original = { ...seams };
afterEach(() => {
  Object.assign(seams, original);
});

describe("no-throw fuzz", () => {
  it("characters: 3,000 inputs from seed 1", () => {
    expect(run((s) => characters(s, 40), 1, 3000).failures).toEqual([]);
  });

  it("tokens: 3,000 inputs from seed 1", () => {
    expect(run(tokens, 1, 3000).failures).toEqual([]);
  });

  it("expression-heavy: 3,000 inputs from seed 1 (PR 3, brief §1.4)", () => {
    expect(run(expressionHeavy, 1, 3000).failures).toEqual([]);
  });

  it("a template-parser throw is classed by its message as a template throw, a front-end throw as a failure", () => {
    seams.createParser = () =>
      ({
        parse() {
          throw new Error("injected template parser failure");
        },
      }) as unknown as ReturnType<typeof seams.createParser>;
    const template = run(() => "<a/>", 1, 1);
    expect(template.templateThrows).toHaveLength(1);
    expect(template.failures).toEqual([]);

    Object.assign(seams, original);
    seams.frontEndRules = () => {
      throw new Error("injected after parse");
    };
    const frontEnd = run(() => "div(a", 1, 1);
    expect(frontEnd.templateThrows).toEqual([]);
    expect(frontEnd.failures).toHaveLength(1);
  });

  it("the generators are deterministic per seed", () => {
    expect(characters(7, 40)).toBe(characters(7, 40));
    expect(tokens(7)).toBe(tokens(7));
    expect(expressionHeavy(7)).toBe(expressionHeavy(7));
  });
});
