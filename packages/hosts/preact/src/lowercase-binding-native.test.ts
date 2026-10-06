// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source uses `${...}` placeholders.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

// Decision 164 + addendum 1: a lowercase tag is the native element, or a
// registered tag, or (when it names a tag binding and is neither) an error.
const NOT_A_TAG = (name: string, bound: string, kind = "import") =>
  `\`<${name}>\` is not a tag here: ${bound}, and a lowercase tag never calls a binding. Write \`<${name[0]?.toUpperCase()}${name.slice(1)}>\` (rename the ${kind}) or \`<\${${name}}/>\``;

/** Compiles `source` as `main.mx` beside a `tags/row.marko` taglib tag. */
function withTaglibRow(source: string, warnings: MxWarning[]): string {
  const scratch = mkdtempSync(join(tmpdir(), "mx-preact-row4-"));
  try {
    mkdirSync(join(scratch, "tags"));
    writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
    writeFileSync(join(scratch, "tags", "row.marko"), "<p>${input.label}</p>");
    return compilePreactMx(source, join(scratch, "main.mx"), { warnings }).code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("lowercase tag with a same-named binding in scope", () => {
  it("row 1: native + define: `<define/span>` does not capture `<span>`, with a warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compilePreactMx(
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
    const { code } = compilePreactMx(
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
    const { code } = compilePreactMx(
      `import { span } from "./x.ts"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title="search" />');
    expect(warnings).toEqual([]);
  });

  it("row 3: unknown + tag import is a positioned error", () => {
    expect(() =>
      compilePreactMx(
        `import row from "./row.mx"\n<row label="x"/>\n`,
        "/fixtures/a.mx",
      ),
    ).toThrow(NOT_A_TAG("row", "`row` is imported from ./row.mx"));
  });

  it("row 3: unknown + lowercase define is the same error, naming where it is defined", () => {
    expect(() =>
      compilePreactMx(`<define/row|x|>d</define>\n<row/>\n`, "/fixtures/a.mx"),
    ).toThrow(NOT_A_TAG("row", "`row` is defined at 1:9", "define"));
  });

  it("a `_`-prefixed tag import gets the same error, offering only the dynamic tag", () => {
    expect(() =>
      compilePreactMx(
        `import _row from "./row.mx"\n<_row/>\n`,
        "/fixtures/a.mx",
      ),
    ).toThrow(
      "`<_row>` is not a tag here: `_row` is imported from ./row.mx, and a lowercase tag never calls a binding. Write `<${_row}/>`",
    );
  });

  it("a named import from a tag module is a value: native and silent", () => {
    const warnings: MxWarning[] = [];
    const { code } = compilePreactMx(
      `import { span } from "./forms.mx"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title="search" />');
    expect(warnings).toEqual([]);
  });

  it("row 4: registered + tag import: the taglib tag is called, not the import", () => {
    const warnings: MxWarning[] = [];
    const code = withTaglibRow(
      `import row from "./row.mx"\n<row label="x"/>\n`,
      warnings,
    );
    expect(code).toContain('import _row from "./tags/row.marko"');
    expect(code.split('"./tags/row.marko"')).toHaveLength(2);
    expect(code).toContain('<_row label="x" />');
    expect(code).not.toContain("__mxRow");
    expect(code).not.toContain('<row label="x" />');
    expect(warnings).toEqual([]);
  });

  it("row 4: registered + lowercase define: the taglib tag is called, imported once", () => {
    const warnings: MxWarning[] = [];
    const code = withTaglibRow(
      `<define/row|x|>d</define>\n<row label="x"/>\n`,
      warnings,
    );
    expect(code).toContain('import _row from "./tags/row.marko"');
    expect(code.split('"./tags/row.marko"')).toHaveLength(2);
    expect(code).toContain('<_row label="x" />');
    expect(code).not.toContain("__mxRow");
    expect(warnings).toEqual([]);
  });

  it("a dynamic tag still calls the binding, with no warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compilePreactMx(
      `import { span } from "./x.ts"\n<\${span} title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain("span");
    expect(code).not.toContain('<span title="search" />');
    expect(warnings).toEqual([]);
  });
});
