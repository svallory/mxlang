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
    ).toThrow(
      "`<row>` is not a tag here: `row` is imported from ./row.mx, and a lowercase tag never calls a binding. Write `<Row>` (rename the import) or `<${row}/>`",
    );
  });

  it("the same error names where a lowercase `<define>` is defined", () => {
    expect(() =>
      compile(`<define/row|x|>d</define>\n<row/>\n`, "/fixtures/a.mx"),
    ).toThrow(
      "`<row>` is not a tag here: `row` is defined at 1:9, and a lowercase tag never calls a binding. Write `<Row>` (rename the define) or `<${row}/>`",
    );
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

  it("`_` and `$` names follow Marko's tag-name rule, offering only the dynamic tag", () => {
    expect(() =>
      compile(`import _row from "./row.mx"\n<_row/>\n`, "/fixtures/a.mx"),
    ).toThrow(
      "`<_row>` is not a tag here: `_row` is imported from ./row.mx, and a lowercase tag never calls a binding. Write `<${_row}/>`",
    );
    expect(() =>
      compile(`import $row from "./row.mx"\n<$row/>\n`, "/fixtures/a.mx"),
    ).toThrow("Write `<${$row}/>`");
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

  it("a registered taglib tag is still called, whatever is imported", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mx-html-row4-"));
    try {
      mkdirSync(join(scratch, "tags"));
      writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(scratch, "tags", "row.marko"),
        "<p>${input.label}</p>",
      );
      const warnings: MxWarning[] = [];
      const { code } = compile(
        `import row from "./row.mx"\n<row label="x"/>\n`,
        join(scratch, "main.mx"),
        { warnings },
      );
      expect(code).toContain('import _row from "./tags/row.marko"');
      expect(code).toContain("_row.render({");
      expect(code).not.toContain('<row label=\\"x\\"');
      expect(warnings).toEqual([]);
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
