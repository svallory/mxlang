// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * Brief §1.2 F: the front end's time grows linearly with its input. Each
 * shape is parsed at n and 10n; a linear front end gives a ratio near 10, a
 * quadratic one near 100. The bound of 30 leaves room for a loaded machine
 * (the style of the template parser's `parseScaling` guard).
 */
import { describe, expect, it } from "vitest";
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
    `<div ${Array.from({ length: n }, (_, i) => `a${i}=[:b, ${i}] .c${i}`).join(" ")}/>`,
};

function best(source: string): number {
  let min = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    parse(source, OPTIONS);
    min = Math.min(min, performance.now() - started);
  }
  return min;
}

export function scaling(shape: (n: number) => string, n: number): number {
  best(shape(n)); // warm up
  return best(shape(n * 10)) / Math.max(best(shape(n)), 0.5);
}

describe("linear scaling", () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`${name}: 10x the input takes at most ~10x the time`, () => {
      const n = name === "deep" ? 500 : 2_000;
      expect(scaling(shape, n)).toBeLessThan(30);
    }, 60_000);
  }

  it("20,000 nested tags build a tree without overflowing the stack", () => {
    const document = parse(SHAPES.deep?.(20_000) ?? "", OPTIONS);
    expect(document.errors).toEqual([]);
    expect(document.body).toHaveLength(1);
  });
});
