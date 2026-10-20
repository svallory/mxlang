import { describe, expect, it } from "vitest";
import { compileHonoMx, compileHonoRegion } from "./index.ts";

/**
 * Wiring smoke only: Hono compiles through `@mxlang/host-preact`'s shared
 * emitter, so the attribute-argument matrix (every spelling, both doors) is
 * pinned once in `packages/hosts/preact/src/attribute-args.test.ts`. This file
 * proves both Hono doors (whole-file and `.hono.mx` region) refuse the same
 * construct.
 */
describe("attribute arguments (hono)", () => {
  it.each([
    ["file", (s: string) => compileHonoMx(s, "/v/test.mx")],
    [
      "region",
      (s: string) => compileHonoRegion(s, { filename: "/v/test.hono.mx" }),
    ],
  ] as const)("refuses them through the %s door", (_entry, compile) => {
    expect(() => compile("<button onClick(v)=() => {}/>")).toThrow(
      "Unsupported arguments on the `onClick` attribute.",
    );
  });

  it("keeps method shorthand valid", () => {
    expect(() =>
      compileHonoMx("<button onClick(v) { return v }/>", "/v/test.mx"),
    ).not.toThrow();
  });
});
