import { describe, expect, it } from "vitest";
import { compileNgMx } from "../src/ng-mx.ts";
import { assertAngularParses } from "./helpers.ts";

// A lowercase tag is a native element whatever binding is in scope: `input`
// is imported by almost every modern Angular component (signal inputs).
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
  it("an imported `input` stays a native <input>", () => {
    const { code } = compileNgMx(
      ngMx(
        'import { input } from "@angular/core";',
        '<div><input type="search"/></div>',
      ),
      "x.component.ng.mx",
    );
    const template = templateOf(code);
    expect(template).toBe('<div><input type="search"></div>');
    expect(template).not.toContain("ngComponentOutlet");
    assertAngularParses(template);
  });
});
