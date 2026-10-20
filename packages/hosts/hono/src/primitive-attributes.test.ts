import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

/**
 * Wiring smoke only: Hono compiles through `@mxlang/host-preact`'s shared
 * emitter, so the primitive-attribute normalization matrix is pinned once in
 * `packages/hosts/preact/src/primitive-attributes.test.ts`. This file proves
 * native dynamic attributes route through the shared helper in Hono's output.
 */
describe("hono primitive attribute normalization", () => {
  it("routes native dynamic attributes, class included, through the helper", () => {
    const code = compileHonoMx(
      "<div data-x=input.d class=input.c/>",
      "/virtual/page.mx",
    ).code;
    expect(code).toContain('__mxAttrValue("data-x", input.d, "div")');
    expect(code).toContain('__mxAttrValue("class", input.c, "div")');
    expect(
      compileHonoMx("<div ...input.rest/>", "/virtual/page.mx").code,
    ).toContain('__mxAttrSpread({ ...input.rest }, "div"');
  });
});
