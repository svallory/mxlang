// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source uses `${...}` placeholders.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileHonoMx } from "./index.ts";

// Decision 164 + addendum 1: a lowercase tag is the native element, or a
// registered tag, or (when it names a tag binding and is neither) an error.
// Only a host's own taglib registers a tag: a `marko.json` is not read
// (decision 197), so the `marko.json` tag below is no longer row 4.
const LOCAL_VARIABLE = (name: string) =>
  `Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use \`<\${${name}}/>\` or rename to \`${name[0]?.toUpperCase()}${name.slice(1)}\`.`;

// The authored `./row.mx` the import binds.
const AUTHORED_ROW = [
  "export interface Input { label: number; item?: { x: number } }",
  "<i>${input.label}</i>",
  "<return value=42/>",
].join("\n");

/** Compiles `source` as `main.mx` beside a `marko.json` naming `<row>` (`impl/row.mx`) and an authored `row.mx`. */
function withTaglibRow(source: string, warnings: MxWarning[] = []): string {
  const scratch = mkdtempSync(join(tmpdir(), "mx-hono-row4-"));
  try {
    mkdirSync(join(scratch, "tags"));
    writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
    mkdirSync(join(scratch, "impl"));
    writeFileSync(
      join(scratch, "marko.json"),
      JSON.stringify({ "<row>": { template: "./impl/row.mx" } }),
    );
    writeFileSync(join(scratch, "impl", "row.mx"), "<p>${input.label}</p>");
    writeFileSync(join(scratch, "row.mx"), AUTHORED_ROW);
    return compileHonoMx(source, join(scratch, "main.mx"), { warnings }).code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

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

  it("a lowercase value import that is no element is the same Marko error (core rule, every host)", () => {
    let error: unknown;
    try {
      compileHonoMx(
        `import layout from "./layout.ts"\n<layout/>\n`,
        "/fixtures/a.mx",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message: LOCAL_VARIABLE("layout"),
      line: 2,
      column: 1,
    });
  });

  it("row 3: unknown + tag import is a positioned error", () => {
    expect(() =>
      compileHonoMx(
        `import row from "./row.mx"\n<row label="x"/>\n`,
        "/fixtures/a.mx",
      ),
    ).toThrow(LOCAL_VARIABLE("row"));
  });

  it("row 3: unknown + lowercase define is the same error, naming where it is defined", () => {
    expect(() =>
      compileHonoMx(`<define/row|x|>d</define>\n<row/>\n`, "/fixtures/a.mx"),
    ).toThrow(LOCAL_VARIABLE("row"));
  });

  it("a `_`-prefixed tag import gets the same error, offering only the dynamic tag", () => {
    expect(() =>
      compileHonoMx(`import _row from "./row.mx"\n<_row/>\n`, "/fixtures/a.mx"),
    ).toThrow(LOCAL_VARIABLE("_row"));
  });

  it("a named import from a tag module is a value: native and silent", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileHonoMx(
      `import { span } from "./forms.mx"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title="search" />');
    expect(warnings).toEqual([]);
  });

  it("row 4: a `marko.json` registers nothing (decision 197), so a tag import is row 3's error", () => {
    expect(() =>
      withTaglibRow(`import row from "./row.mx"\n<row label="x"/>\n`),
    ).toThrow(LOCAL_VARIABLE("row"));
  });

  it("row 4: a `marko.json` registers nothing, so a lowercase define is row 3's error", () => {
    expect(() =>
      withTaglibRow(`<define/row|x|>d</define>\n<row label="x"/>\n`),
    ).toThrow(LOCAL_VARIABLE("row"));
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
