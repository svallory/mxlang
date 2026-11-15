// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * Brief §1.2 F: the front end's time grows linearly with its input. Each
 * shape is parsed at n and 10n; a linear front end gives a ratio near 10, a
 * quadratic one near 100. The bound of 30 leaves room for a loaded machine
 * (the style of the template parser's `parseScaling` guard).
 */
import type { MxFrontEndOptions } from "@mxlang/babel/mx-ast";
import { describe, expect, it } from "vitest";
import { DEFAULT_SYNTAX } from "../template/index.ts";
import { MEMBER } from "../template/test-support/sugar-rows.ts";
import { parse } from "./parse.ts";
import { OPTIONS } from "./test-support/options.ts";

const SHAPES: Record<string, (n: number) => string> = {
  wide: (n) =>
    Array.from(
      { length: n },
      (_, i) => `<p class="c${i}">t ${"${x}"}</p>`,
    ).join("\n"),
  deep: (n) => `${"<div>".repeat(n)}x${"</div>".repeat(n)}`,
  "attribute-heavy": (n) =>
    `<div ${Array.from({ length: n }, (_, i) => `a${i}=[b, ${i}] .c${i}`).join(" ")}/>`,
  // PR 3 (brief §1.4): expression parsing on, linear with the same bound.
  "many-small-expressions": (n) =>
    `<p>${Array.from({ length: n }, (_, i) => `\${a${i} + b}`).join("")}</p>`,
  "one-large-expression": (n) =>
    `<p>\${${Array.from({ length: n }, (_, i) => `(a${i} + ${i})`).join(" + ")}}</p>`,
};

function best(source: string, options: MxFrontEndOptions = OPTIONS): number {
  let min = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    parse(source, options);
    min = Math.min(min, performance.now() - started);
  }
  return min;
}

export function scaling(
  shape: (n: number) => string,
  n: number,
  options: MxFrontEndOptions = OPTIONS,
): number {
  best(shape(n), options); // warm up
  return best(shape(n * 10), options) / Math.max(best(shape(n), options), 0.5);
}

describe("linear scaling", () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`${name}: 10x the input takes at most ~10x the time`, () => {
      const n =
        name === "deep" ? 500 : name === "one-large-expression" ? 1_000 : 2_000;
      expect(scaling(shape, n)).toBeLessThan(30);
    }, 60_000);
  }

  // An armed expression row looks behind past the comments read so far in
  // its expression at every candidate character; one flat array literal keeps
  // Babel's tree shallow while every item puts comments before a trigger.
  // Three comments per item make each look-behind step over several, so a
  // per-step scan of every comment read so far clearly breaks the bound. One
  // item per line: Babel scans from each block comment to the next line
  // break, so on a single line that scan alone grows quadratically.
  it("many-comments-in-one-expression: 10x the input takes at most ~10x the time", () => {
    const item = (i: number) => `/*c${i}*/ /*d${i}*/ /*e${i}*/ &a${i}`;
    const shape = (n: number) =>
      `<p>\${[${Array.from({ length: n }, (_, i) => item(i)).join(",\n")}]}</p>`;
    const options = {
      ...OPTIONS,
      syntax: { ...DEFAULT_SYNTAX, expressionTriggers: [MEMBER] },
    };
    expect(scaling(shape, 2_000, options)).toBeLessThan(30);
  }, 60_000);

  it("20,000 nested tags build a tree without overflowing the stack", () => {
    const document = parse(SHAPES.deep?.(20_000) ?? "", OPTIONS);
    expect(document.errors).toEqual([]);
    expect(document.body).toHaveLength(1);
  });
});
