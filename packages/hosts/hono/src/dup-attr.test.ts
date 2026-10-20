import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

/**
 * Wiring smoke only: Hono compiles through `@mxlang/host-preact`'s shared
 * emitter (`hono/src/index.ts`), so the duplicate-attribute matrix — per-name
 * warnings, UTF-16 columns, survivor positions, spreads — is pinned once in
 * `packages/hosts/preact/src/dup-attr.test.ts`. This file proves the warning
 * channel is wired through `compileHonoMx` (core's last-wins rule with a
 * positioned warning), not re-asserts every row.
 */
describe("duplicate attributes (hono)", () => {
  it("warns once at the dropped occurrence, naming the survivor", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileHonoMx(
      '<div class="a" class="b">hi</div>',
      "/fixtures/test.mx",
      { warnings },
    );
    expect(warnings).toEqual([
      {
        message:
          "duplicate attribute `class`: the later one at 1:16 wins, so this one is dropped",
        line: 1,
        column: 5,
        end: { line: 1, column: 14 },
        file: "/fixtures/test.mx",
        code: "MX_DUPLICATE_ATTRIBUTE",
      },
    ]);
    // Only the survivor is emitted.
    expect(code).toContain('class="b"');
    expect(code).not.toContain('class="a"');
  });
});
