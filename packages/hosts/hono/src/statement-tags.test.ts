import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

/**
 * Wiring smoke only: Hono compiles through `@mxlang/host-preact`'s shared
 * emitter, so the statement-tag matrix (every statement kind, positioned
 * refusals, Marko-style text checks) is pinned once in
 * `packages/hosts/preact/src/statement-tags.test.ts`.
 */
describe("statement tags (hono)", () => {
  it("compiles a typed function statement", () => {
    expect(
      compileHonoMx(
        "static function f(a: number): string { return String(a) }",
        "/f/t.mx",
      ).code,
    ).toContain("function f(a: number): string { return String(a) }");
  });

  it("refuses `client` with a positioned message", () => {
    let error: { message: string; line: number } | undefined;
    try {
      compileHonoMx("client console.log(1)\n<div/>", "/f/t.mx");
    } catch (thrown) {
      error = thrown as { message: string; line: number };
    }
    expect(error?.message).toContain("`client`");
    expect(error?.line).toBe(1);
  });
});
