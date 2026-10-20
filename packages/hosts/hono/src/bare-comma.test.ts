import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

/**
 * Wiring smoke only: Hono compiles through `@mxlang/host-preact`'s shared
 * emitter, so the bare-`,` matrix (every top-level shape, positions) is pinned
 * once in `packages/hosts/preact/src/bare-comma.test.ts`. This file proves
 * core's positioned error (not Marko's `TypeError`) reaches `compileHonoMx`
 * callers.
 */
describe("a bare `,` line (hono)", () => {
  it("is a positioned error, not a throw", () => {
    let error: unknown;
    try {
      compileHonoMx(",", "a.mx");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      message:
        "a `,` continues the attributes of the tag above; there is no tag here",
      line: 1,
      column: 0,
    });
  });

  it("a `,` that continues a tag above still compiles", () => {
    expect(() => compileHonoMx('div\n  , class="a"', "a.mx")).not.toThrow();
  });
});
