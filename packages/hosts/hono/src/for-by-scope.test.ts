// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal mx source
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

/**
 * Wiring smoke only: Hono compiles through `@mxlang/host-preact`'s shared
 * emitter, so the `<for by=>` loop-param matrix (every `<for>` form, first-read
 * positioning) is pinned once in `packages/hosts/preact/src/for-by-scope.test.ts`.
 * This file proves the error reaches `compileHonoMx` callers.
 */
describe("<for by=> reads a loop param (hono)", () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
  const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  it("rejects it at the name read", () => {
    let failure: { message: string; line: number; column: number } | undefined;
    try {
      compileHonoMx(
        "<for|x| of=items by=x.id><p>${x.id}</p></for>",
        "/fixtures/test.mx",
      );
    } catch (error) {
      const e = error as { message: string; line: number; column: number };
      failure = {
        message: stripAnsi(e.message),
        line: e.line,
        column: e.column,
      };
    }
    expect(failure?.message).toContain(
      "The `by=` attribute is evaluated before the loop runs, so `x` is not in scope.",
    );
    expect(failure).toMatchObject({ line: 1, column: 20 });
  });

  it("accepts the forms Marko accepts", () => {
    for (const ok of [
      "<for|x| of=items by=(x) => x.id><p>${x.id}</p></for>",
      '<for|x| of=items by="id"><p>${x.id}</p></for>',
      "<for|x| of=items><p>${x.id}</p></for>",
    ]) {
      expect(() => compileHonoMx(ok, "/fixtures/test.mx")).not.toThrow();
    }
  });
});
