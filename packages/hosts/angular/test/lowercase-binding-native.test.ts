// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX source and messages use `${...}` placeholders.

import type { CustomTag, MxWarning } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compileNgMx } from "../src/ng-mx.ts";
import { assertAngularParses } from "./helpers.ts";

// Decision 164 + addendum 1. `input` is imported by almost every modern
// Angular component (signal inputs): it is a value import, so never a tag.
function ngMx(importLine: string, template: string): string {
  return [
    'import { Component } from "@angular/core";',
    importLine,
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    "export class XComponent {}",
  ].join("\n");
}

function templateOf(code: string): string {
  const match = /template: `([\s\S]*?)`/.exec(code);
  if (!match?.[1]) throw new Error(`no template in:\n${code}`);
  return match[1];
}

describe("lowercase tag with a same-named binding in scope", () => {
  it("an imported `input` stays a native <input>, with no warning", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileNgMx(
      ngMx(
        'import { input } from "@angular/core";',
        '<div><input type="search"/></div>',
      ),
      "x.component.ng.mx",
      { warnings },
    );
    const template = templateOf(code);
    expect(template).toBe('<div><input type="search"></div>');
    expect(template).not.toContain("ngComponentOutlet");
    assertAngularParses(template);
    expect(warnings).toEqual([]);
  });

  it("row 2: a `.mx` tag import named like an element stays native, warning at the import's L:C", () => {
    const warnings: MxWarning[] = [];
    const { code } = compileNgMx(
      ngMx(
        'import input from "./input.mx";',
        '<div><input type="search"/></div>',
      ),
      "x.component.ng.mx",
      { warnings },
    );
    expect(templateOf(code)).toBe('<div><input type="search"></div>');
    expect(warnings.map((w) => [w.line, w.message])).toEqual([
      [
        5,
        "`<input>` is the native element; the `input` imported at 2:1 is not called. Rename it `Input` or write `<${input}>`",
      ],
    ]);
  });

  it("row 3: an unknown tag naming a `.mx` tag import is the same error as on every target", () => {
    expect(() =>
      compileNgMx(
        ngMx('import row from "./row.mx";', '<div><row label="x"/></div>'),
        "x.component.ng.mx",
      ),
    ).toThrow(
      "`<row>` is not a tag here: `row` is imported from ./row.mx, and a lowercase tag never calls a binding. Write `<Row>` (rename the import) or `<${row}/>`",
    );
  });

  it("row 4: a registered custom tag is still called, whatever is imported", () => {
    const customTags: Record<string, CustomTag> = {
      row: { transform: (call) => call.content?.children ?? [] },
    };
    const { code } = compileNgMx(
      ngMx('import row from "./row.mx";', "<div><row>x</row></div>"),
      "x.component.ng.mx",
      { customTags },
    );
    expect(templateOf(code)).toBe("<div>x</div>");
  });
});
