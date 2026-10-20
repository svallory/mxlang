// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source uses `${...}` placeholders.
import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

/**
 * Wiring smoke only: Hono compiles through `@mxlang/host-preact`'s shared
 * emitter, so the full lowercase-binding matrix (every row, the `marko.json`
 * rules, dynamic tags) is pinned once in
 * `packages/hosts/preact/src/lowercase-binding-native.test.ts`. This file
 * proves the warning and error channels are wired through `compileHonoMx`.
 */
const LOCAL_VARIABLE = (name: string) =>
  `Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use \`<\${${name}}/>\` or rename to \`${name[0]?.toUpperCase()}${name.slice(1)}\`.`;

describe("lowercase tag with a same-named binding in scope (hono)", () => {
  it("native + define: the define does not capture the element, with a warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileHonoMx(
      `<define/span|x|>d</define>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title="search" />');
    expect(warnings.map((w) => [w.line, w.column, w.message])).toEqual([
      [
        2,
        0,
        "`<span>` is the native element; the `span` defined at 1:9 is not called. Rename it `Span` or write `<${span}>`",
      ],
    ]);
  });

  it("unknown + tag import is a positioned error", () => {
    expect(() =>
      compileHonoMx(
        `import row from "./row.mx"\n<row label="x"/>\n`,
        "/fixtures/a.mx",
      ),
    ).toThrow(LOCAL_VARIABLE("row"));
  });
});
