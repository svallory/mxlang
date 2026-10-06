// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source uses `${...}` placeholders.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

// Decision 164 + addendum 1: a lowercase tag is the native element, or a
// registered tag, or (when it names a tag binding and is neither) an error.
const NOT_A_TAG = (name: string, bound: string) =>
  `\`<${name}>\` is not a tag here: ${bound}, and a lowercase tag never calls a binding. Write \`<${name[0]?.toUpperCase()}${name.slice(1)}>\` (rename the import) or \`<\${${name}}/>\``;

describe("lowercase tag with a same-named binding in scope", () => {
  it("row 1: native + define: `<define/span>` does not capture `<span>`, with a warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileHonoMx(
      `<define/span|x|>d</define>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title="search" />');
    expect(code).not.toContain("span(undefined)");
    expect(warnings.map((w) => [w.line, w.column, w.message])).toEqual([
      [
        2,
        0,
        `\`<span>\` is the native element; the \`span\` defined at 1:9 is not called. Rename it \`Span\` or write \`<\${span}>\``,
      ],
    ]);
  });

  it("row 2: native + tag import: `<span>` stays native, warning carries the import's L:C", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileHonoMx(
      `import span from "./span.mx"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title="search" />');
    expect(warnings.map((w) => [w.line, w.column, w.message])).toEqual([
      [
        2,
        0,
        `\`<span>\` is the native element; the \`span\` imported at 1:1 is not called. Rename it \`Span\` or write \`<\${span}>\``,
      ],
    ]);
  });

  it("a value import never triggers the diagnostic", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileHonoMx(
      `import { span } from "./x.ts"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title="search" />');
    expect(warnings).toEqual([]);
  });

  it("row 3: unknown + tag import is a positioned error", () => {
    expect(() =>
      compileHonoMx(
        `import row from "./row.mx"\n<row label="x"/>\n`,
        "/fixtures/a.mx",
      ),
    ).toThrow(NOT_A_TAG("row", "`row` is imported from ./row.mx"));
  });

  it("row 3: unknown + lowercase define is the same error, naming where it is defined", () => {
    expect(() =>
      compileHonoMx(`<define/row|x|>d</define>\n<row/>\n`, "/fixtures/a.mx"),
    ).toThrow(NOT_A_TAG("row", "`row` is defined at 1:9"));
  });

  it("a `_`-prefixed tag import gets the same error", () => {
    expect(() =>
      compileHonoMx(`import _row from "./row.mx"\n<_row/>\n`, "/fixtures/a.mx"),
    ).toThrow("is not a tag here");
  });

  it("row 4: registered + tag import: a taglib tag is still called", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mx-hono-row4-"));
    try {
      mkdirSync(join(scratch, "tags"));
      writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(scratch, "tags", "row.marko"),
        "<p>${input.label}</p>",
      );
      const warnings: MxWarning[] = [];
      const { code } = compileHonoMx(
        `import row from "./row.mx"\n<row label="x"/>\n`,
        join(scratch, "main.mx"),
        { warnings },
      );
      expect(code).not.toContain('<row label="x" />');
      expect(code).toContain("row");
      expect(warnings).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("a dynamic tag still calls the binding, with no warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileHonoMx(
      `import { span } from "./x.ts"\n<\${span} title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain("span");
    expect(code).not.toContain('<span title="search" />');
    expect(warnings).toEqual([]);
  });
});
