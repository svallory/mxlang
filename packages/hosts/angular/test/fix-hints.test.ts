// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX source
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { build } from "../src/build.ts";
import { compileNgMx } from "../src/ng-mx.ts";

const projectDir = resolve(
  import.meta.dirname,
  "../../../tooling/angular-checker",
);
const file = join(projectDir, "fix-hints.ng.mx");
const moduleFor = (template: string, body = 'title = "hi"; items = [1, 2];') =>
  [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    `export class XComponent { ${body} }`,
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
const SWITCH_MESSAGE =
  "Unable to find entry point for custom tag `<switch>`. MX has no switch; use `<if=…>` / `<else if=…>`.";
/** 0-based column of `needle`'s first occurrence, matching the emitter's Position basis. */
function authoredColumn(source: string, needle: string): number {
  const offset = source.indexOf(needle);
  return offset - source.lastIndexOf("\n", offset) - 1;
}

describe("Angular fix hints (a16)", () => {
  it.each([
    [
      "a default attribute",
      '<div><switch=title><case="a"><p>a</p></case></switch></div>',
      '<div><if=(title === "a")><p>a</p></if><else if=(title === "b")><p>b</p></else></div>',
    ],
    [
      "no value",
      '<div><switch><case="a"><p>a</p></case><case="b">b</case></switch></div>',
      '<div><if=(title === "a")><p>a</p></if><else if=(title === "b")>b</else></div>',
    ],
    [
      "a named value attribute",
      '<div><switch value=title><case="a">a</case></switch></div>',
      '<div><if=(title === "a")>a</if></div>',
    ],
    [
      "cases nested under a <for>",
      '<switch=title><for|x| of=items><case="a">${x}</case></for></switch>',
      '<if=(title === "a")><for|x| of=items><p>${x}</p></for></if>',
    ],
  ])(
    "rejects a switch with %s once at the switch name, before ngtsc",
    (_label, template, fixed) => {
      const source = moduleFor(template);
      expect(failure(source)).toEqual({
        message: SWITCH_MESSAGE,
        line: 5,
        column: authoredColumn(source, "switch"),
      });
      clean(moduleFor(fixed));
    },
  );

  it("does not reject an SVG switch of graphics elements", () => {
    clean(moduleFor("<svg><switch><text>x</text></switch></svg>"));
  });

  it("rejects a case child of an SVG switch as attempted control flow", () => {
    const source = moduleFor(
      '<svg><switch><case="a"><text>a</text></case></switch></svg>',
    );
    expect(failure(source)).toEqual({
      message: SWITCH_MESSAGE,
      line: 5,
      column: authoredColumn(source, "switch"),
    });
    clean(moduleFor("<svg><switch><text>x</text></switch></svg>"));
  });

  it("keeps a tags/-discovered switch component", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-angular-switch-tag-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "switch-tag",
          mx: { host: "angular", angular: { include: ["src/**/*.ng.mx"] } },
        }),
      );
      const tag =
        "export interface Input { label: string }\n<p>${input.label}</p>";
      mkdirSync(join(dir, "src/app/tags"), { recursive: true });
      writeFileSync(join(dir, "src/app/tags/switch.mx"), tag);
      writeFileSync(
        join(dir, "src/app/x.component.ng.mx"),
        [
          'import { Component } from "@angular/core";',
          "",
          '@Component({ selector: "app-x", imports: [],',
          "  template: <switch label=title/>,",
          "})",
          'export class XComponent { title = "hi"; }',
        ].join("\n"),
      );
      const result = build(dir);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an imported Switch component", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-angular-Switch-import-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "switch-import",
          mx: { host: "angular", angular: { include: ["src/**/*.ng.mx"] } },
        }),
      );
      const tag =
        "export interface Input { label: string }\n<p>${input.label}</p>";
      mkdirSync(join(dir, "src/app/tags"), { recursive: true });
      writeFileSync(join(dir, "src/app/tags/switch.mx"), tag);
      writeFileSync(
        join(dir, "src/app/x.component.ng.mx"),
        [
          'import { Component } from "@angular/core";',
          'import Switch from "./tags/switch.mx";',
          "",
          '@Component({ selector: "app-x", imports: [Switch],',
          "  template: <Switch label=title/>,",
          "})",
          'export class XComponent { title = "hi"; }',
        ].join("\n"),
      );
      const result = build(dir);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Angular fix hints (a14)", () => {
  const KEYED_MESSAGE =
    "The `by=` arrow parameter `y` must match the `<for>` row `x`; rename it to keep the key expression: `by=(x => x.id)`. If the row has no `id` field, `by=identity` is a different strategy that tracks the row itself.";
  const objectRows = "items = [{ id: 1 }, { id: 2 }];";

  it("advises the rename that keeps a keyed arrow's key expression", () => {
    const source = moduleFor(
      "<ul><for|x| of=items by=(y=>y.id)><li>${x}</li></for></ul>",
      objectRows,
    );
    expect(failure(source)).toEqual({
      message: KEYED_MESSAGE,
      line: 5,
      column: authoredColumn(source, "y=>"),
    });
    const renamed = source.replace("by=(y=>y.id)", "by=(x=>x.id)");
    // The faithful fix compiles clean and its tracking expression survives
    // verbatim in the emitted template.
    clean(renamed);
    expect(compileNgMx(renamed, file).code).toContain("track x.id");
  });

  it("keeps the numeric corpus case on the identity fallback, worded as a different strategy", () => {
    // The corpus row is numeric (`items = [1, 2]`), so the renamed key
    // `x.id` does not type-check; the message names `by=identity` as a
    // DIFFERENT strategy for rows without the field, and that compiles
    // clean with `track x`.
    const source = moduleFor(
      "<ul><for|x| of=items by=(y=>y.id)><li>${x}</li></for></ul>",
    );
    expect(failure(source)).toEqual({
      message: KEYED_MESSAGE,
      line: 5,
      column: authoredColumn(source, "y=>"),
    });
    clean(source.replace("by=(y=>y.id)", "by=identity"));
    expect(
      compileNgMx(source.replace("by=(y=>y.id)", "by=identity"), file).code,
    ).toContain("track x)");
  });

  it("suggests by=identity only when the arrow tracks the parameter itself", () => {
    const source = moduleFor(
      "<ul><for|x| of=items by=(y=>y)><li>${x}</li></for></ul>",
      objectRows,
    );
    expect(failure(source)).toEqual({
      message:
        "The `by=` arrow parameter `y` must match the `<for>` row `x`; use `by=identity` to track the row itself.",
      line: 5,
      column: authoredColumn(source, "y=>"),
    });
    clean(source.replace("by=(y=>y)", "by=identity"));
    clean(source.replace("by=(y=>y)", "by=(x=>x)"));
  });
});
