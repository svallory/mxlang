// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX source
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";

const projectDir = resolve(
  import.meta.dirname,
  "../../../tooling/angular-checker",
);
const file = join(projectDir, "fix-hints.ng.mx");
const moduleFor = (template: string) =>
  [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    'export class XComponent { title = "hi"; items = [1, 2]; }',
  ].join("\n");

// biome-ignore lint/suspicious/noControlCharactersInRegex: messages can carry ANSI colour
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
function failure(source: string) {
  try {
    compileNgMx(source, file);
  } catch (error) {
    const e = error as {
      message: string;
      line?: number;
      column?: number;
      loc?: { line: number; column: number };
    };
    return {
      message: strip(e.message).replace(/ \(\d+:\d+\)$/, ""),
      line: e.line ?? e.loc?.line,
      column: e.column ?? e.loc?.column,
    };
  }
  throw new Error("expected one MX compile error");
}
function clean(source: string) {
  const compiled = compileNgMx(source, file);
  const checker = createAngularChecker({ projectDir });
  try {
    expect(checker.check(`${file}.ts`, compiled.code)).toEqual([]);
  } finally {
    checker.dispose();
  }
}

describe("Angular fix hints (a16, a14)", () => {
  it("rejects switch/case once at the switch name, before ngtsc", () => {
    const source = moduleFor(
      '<div><switch=title><case="a"><p>a</p></case></switch></div>',
    );
    expect(failure(source)).toEqual({
      message:
        "Unable to find entry point for custom tag `<switch>`. MX has no switch; use `<if=…>` / `<else if=…>`.",
      line: 5,
      column: 18,
    });
    clean(
      source.replace(
        '<switch=title><case="a"><p>a</p></case></switch>',
        '<if=(title === "a")><p>a</p></if><else if=(title === "b")><p>b</p></else>',
      ),
    );
  });
  it("does not reject SVG switch", () => {
    clean(moduleFor("<svg><switch><text>x</text></switch></svg>"));
  });
  it("names the mismatched arrow parameter at that parameter", () => {
    const source = moduleFor(
      "<ul><for|x| of=items by=(y=>y.id)><li>${x}</li></for></ul>",
    );
    const offset = source.indexOf("y=>");
    expect(failure(source)).toEqual({
      message:
        "The `by=` arrow parameter `y` must match the `<for>` row `x`; use `by=identity` to track the row itself.",
      line: 5,
      column: offset - source.lastIndexOf("\n", offset) - 1,
    });
    clean(source.replace("by=(y=>y.id)", "by=identity"));
    clean(source.replace("by=(y=>y.id)", "by=(x=>x)"));
  });
});
