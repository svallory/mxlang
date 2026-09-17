import { describe, expect, it } from "bun:test";
import { parse } from "../index.ts";

/**
 * The error-positioning contract, under **Bun** specifically.
 *
 * This file exists because the vitest suite *cannot* catch the bug it pins.
 * Vitest runs on Node (V8), where a plain `Error` has only `message` and
 * `stack`. Bun runs on JavaScriptCore, where every `Error` additionally
 * carries own numeric `line`, `column`, `originalLine`, `originalColumn` and
 * `sourceURL` naming its **JS throw site**.
 *
 * So a bridge predicate that treats "has own numeric line/column" as "this
 * error is positioned in the user's file" is correct under vitest and wrong
 * at runtime: a host's plain `Error` gets reported at the host's own source
 * line, inside the user's `.mx`. Measured on PR #105 — a region on line 3
 * reported at (14:5), a position in neither file — and invisible to 15
 * passing vitest tests.
 *
 * Run by `bun run test:bun`, the same channel `@mxlang/html` and
 * `@mxlang/hono` use for their `Bun.plugin` loaders.
 */
describe("mxRegionCompile error positioning (Bun runtime)", () => {
  // Region early, with real content after it, so a wrong line cannot land on
  // the region by coincidence through an end-of-file clamp.
  const REGION_LINE_TEXT = "const v = <div/>;";
  const source = (() => {
    const lines = Array(40).fill("// filler");
    lines[2] = REGION_LINE_TEXT;
    return lines.join("\n");
  })();
  // Derived, never hardcoded: the region's own start is what every
  // fallback below must report, and a magic `(3:10)` would silently stop
  // meaning that if the fixture were ever edited.
  const REGION_LINE = 3; // 1-based; `lines[2]`
  const REGION_COLUMN = REGION_LINE_TEXT.indexOf("<"); // 0-based
  const AT_REGION = `(${REGION_LINE}:${REGION_COLUMN})`;

  it("gives every plain Error own line/column here, unlike V8", () => {
    // The premise the rest of this file rests on. If a future Bun stops
    // doing this, the bridge predicate could be simplified — and this
    // failing test is how we would find out.
    const error = new Error("x") as Error & {
      line?: number;
      column?: number;
    };
    expect(typeof error.line).toBe("number");
    expect(typeof error.column).toBe("number");
  });

  it("positions a host's plain Error at the region, not its own throw site", () => {
    expect(() =>
      parse(source, "x.solid.mx", {
        mxRegionCompile: () => {
          throw new Error("plain failure");
        },
      }),
    ).toThrow(`plain failure ${AT_REGION}`);
  });

  it("positions a thrown non-Error at the region too", () => {
    expect(() =>
      parse(source, "x.solid.mx", {
        mxRegionCompile: () => {
          throw "a string";
        },
      }),
    ).toThrow(`a string ${AT_REGION}`);
  });

  it("still honours a TranslateError's own file-absolute coordinates", () => {
    // The other half of the contract: a deliberately positioned error keeps
    // its coordinates even though a plain `Error` beside it is ignored.
    class TranslateError extends Error {
      constructor(
        message: string,
        readonly line: number,
        readonly column: number,
      ) {
        super(message);
        this.name = "TranslateError";
      }
    }

    expect(() =>
      parse(source, "x.solid.mx", {
        mxRegionCompile: () => {
          throw new TranslateError("elsewhere", 5, 2);
        },
      }),
    ).toThrow(/elsewhere \(5:2\)/);
  });
});
