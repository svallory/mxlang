// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source uses `${...}` placeholders.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

// A lowercase tag is a native element whatever binding is in scope (Marko
// 6.3.51 measured: native for an import and for a lowercase `<define>`).
describe("lowercase tag with a same-named binding in scope", () => {
  // Marko's own message, verbatim (measured on the stock parser,
  // `@marko/compiler` 5.42.11 / `marko` 6.4.4): always at the tag name.
  const LOCAL_VARIABLE = (name: string) =>
    `Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use \`<\${${name}}/>\` or rename to \`${name[0]?.toUpperCase()}${name.slice(1)}\`.`;
  it("an imported `span` stays a native element", () => {
    const { code } = compile(
      `import span from "./span.mx"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
    );
    expect(code).toContain('<span title=\\"search\\"></span>');
    expect(code).not.toContain("__mxRenderDynamic");
  });

  it("a lowercase `<define/span>` does not capture `<span>`", () => {
    const { code } = compile(
      `<define/span|x|>d</define>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
    );
    expect(code).toContain('<span title=\\"search\\"></span>');
    expect(code).not.toContain("span(undefined)");
  });

  it("warns at the tag, naming the import and where it was bound", () => {
    const warnings: MxWarning[] = [];
    compile(
      `import span from "./span.mx"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(warnings.map((w) => [w.line, w.column, w.message])).toEqual([
      [
        2,
        0,
        `\`<span>\` is the native element; the \`span\` imported at 1:1 is not called. Rename it \`Span\` or write \`<\${span}>\``,
      ],
    ]);
  });

  it("warns for a lowercase `<define>`, naming where it was defined", () => {
    const warnings: MxWarning[] = [];
    compile(
      `<define/span|x|>d</define>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(warnings[0]?.message).toBe(
      `\`<span>\` is the native element; the \`span\` defined at 1:9 is not called. Rename it \`Span\` or write \`<\${span}>\``,
    );
  });

  it("a value import never triggers the diagnostic", () => {
    const warnings: MxWarning[] = [];
    const { code } = compile(
      `import { span } from "./x.ts"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title=\\"search\\"></span>');
    expect(warnings).toEqual([]);
  });

  it("an unknown lowercase tag naming a tag import is a positioned error on every target", () => {
    expect(() =>
      compile(
        `import row from "./row.mx"\n<row label="x"/>\n`,
        "/fixtures/a.mx",
      ),
    ).toThrow(LOCAL_VARIABLE("row"));
  });

  it("a lowercase value import that is no element is the same Marko error (core's, on every host)", () => {
    let error: unknown;
    try {
      compile(
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

  it("the same error fires for a lowercase `<define>`", () => {
    expect(() =>
      compile(`<define/row|x|>d</define>\n<row/>\n`, "/fixtures/a.mx"),
    ).toThrow(LOCAL_VARIABLE("row"));
  });

  it("an out-of-scope define does not warn", () => {
    const warnings: MxWarning[] = [];
    compile(
      `<if=x><define/span|y|>d</define></if>\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(warnings).toEqual([]);
  });

  it("`_` and `$` names follow Marko's message, which offers the dynamic tag and the (unchanged) capitalized spelling", () => {
    expect(() =>
      compile(`import _row from "./row.mx"\n<_row/>\n`, "/fixtures/a.mx"),
    ).toThrow(LOCAL_VARIABLE("_row"));
    expect(() =>
      compile(`import $row from "./row.mx"\n<$row/>\n`, "/fixtures/a.mx"),
    ).toThrow(LOCAL_VARIABLE("$row"));
  });

  it("a named import from a tag module is a value: native and silent", () => {
    const warnings: MxWarning[] = [];
    const { code } = compile(
      `import { span } from "./forms.mx"\n<span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain('<span title=\\"search\\"');
    expect(warnings).toEqual([]);
  });

  it("a `marko.json` tag is not registered (decision 197): the import is row 3's error", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mx-html-row4-"));
    try {
      writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
      mkdirSync(join(scratch, "impl"));
      writeFileSync(
        join(scratch, "marko.json"),
        JSON.stringify({ "<row>": { template: "./impl/row.mx" } }),
      );
      writeFileSync(join(scratch, "impl", "row.mx"), "<p>${input.label}</p>");
      writeFileSync(join(scratch, "row.mx"), "<i>${input.label}</i>");
      expect(() =>
        compile(
          `import row from "./row.mx"\n<row label="x"/>\n`,
          join(scratch, "main.mx"),
        ),
      ).toThrow(LOCAL_VARIABLE("row"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("a dynamic tag still calls the binding, with no warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compile(
      `import { span } from "./x.ts"\n<\${span} title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).toContain("__mxRenderDynamic");
    expect(warnings).toEqual([]);
  });

  it("a PascalCase import still resolves as a component, with no warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compile(
      `import Span from "./span.mx"\n<Span title="search"/>\n`,
      "/fixtures/a.mx",
      { warnings },
    );
    expect(code).not.toContain("<span title=");
    expect(warnings).toEqual([]);
  });
});
