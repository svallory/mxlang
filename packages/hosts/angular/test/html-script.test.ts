// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX source
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTemplate } from "@angular/compiler";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";
import { compileTagModule } from "../src/tag-module.ts";

/**
 * `<html-script>` and `<html-style>` are the tags for a native html `<script>`
 * and `<style>` element. Angular's template compiler removes every `<script>`
 * element and lifts every `<style>` out of the template into the component's
 * styles (dropping the element, its attributes such as `media`, and scoping
 * the CSS), so no Angular output can put either on the page as written: the
 * host refuses each tag, once, at its name, with the ways Angular does load a
 * script or a stylesheet. (Stock Marko, and the other hosts, write a real
 * element.)
 */

const file = join(
  resolve(import.meta.dirname, "../../../tooling/angular-checker"),
  "html-script.ng.mx",
);
const moduleFor = (template: string) =>
  [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    'export class XComponent { title = "hi"; }',
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

describe("<html-script> on Angular", () => {
  it("Angular's own template parser drops a <script> element", () => {
    const parsed = parseTemplate(
      '<div></div><script type="module">const a = 1;</script><p>x</p>',
      "x.html",
    );
    expect(parsed.errors ?? []).toEqual([]);
    expect(
      parsed.nodes.map((node) => (node as unknown as { name: string }).name),
    ).toEqual(["div", "p"]);
  });

  it.each([
    ["a body", '<html-script type="module">go(${title});</html-script>'],
    ["no body", '<html-script async src="/a.js"/>'],
    ["inside an element", "<div><html-script>go();</html-script></div>"],
    ["inside a conditional", "<if=title><html-script>go();</html-script></if>"],
  ])(
    "refuses %s once, at the tag name, with the way Angular loads a script",
    (_label, template) => {
      const source = moduleFor(template);
      const error = failure(source);
      expect(error.message).toMatch(/^`<html-script>` cannot be emitted/);
      expect(error.message).toContain("angular.json");
      expect(error.message).toContain("index.html");
      expect(error.line).toBe(5);
      expect(error.column).toBe(
        source.split("\n")[4]?.indexOf("html-script") as number,
      );
    },
  );
});

describe("<html-style> on Angular", () => {
  it("Angular's own template parser lifts a <style> into the styles", () => {
    const parsed = parseTemplate(
      '<style media="print">a{}</style><p>x</p>',
      "x.html",
    );
    expect(parsed.errors ?? []).toEqual([]);
    expect(
      parsed.nodes.map((node) => (node as unknown as { name: string }).name),
    ).toEqual(["p"]);
    expect(parsed.styles).toEqual(["a{}"]);
  });

  it.each([
    ["a body", "<html-style>a { color: red; }</html-style>"],
    ["attributes", '<html-style media="print">a{}</html-style>'],
    ["no body", '<html-style media="print"/>'],
    ["inside an element", "<div><html-style>a{}</html-style></div>"],
    ["inside a conditional", "<if=title><html-style>a{}</html-style></if>"],
  ])(
    "refuses %s once, at the tag name, with the way Angular loads a style",
    (_label, template) => {
      const source = moduleFor(template);
      const error = failure(source);
      expect(error.message).toMatch(/^`<html-style>` cannot be emitted/);
      expect(error.message).toContain("styleUrls");
      expect(error.message).toContain("angular.json");
      expect(error.line).toBe(5);
      expect(error.column).toBe(
        source.split("\n")[4]?.indexOf("html-style") as number,
      );
    },
  );

  it("refuses the concise form in a page at the tag name", () => {
    let error: { message: string; line?: number; column?: number } = {
      message: "",
    };
    try {
      compile('<p>x</p>\nhtml-style media="print" -- a{}\n', "x.mx");
    } catch (e) {
      error = e as typeof error;
    }
    expect(strip(error.message)).toMatch(/^`<html-style>` cannot be emitted/);
    expect(error).toMatchObject({ line: 2, column: 0 });
  });

  it("refuses it in a tag module at the tag name", () => {
    const dir = mkdtempSync(join(tmpdir(), "mx-html-style-"));
    try {
      mkdirSync(join(dir, "tags"));
      writeFileSync(join(dir, "package.json"), "{}");
      const path = join(dir, "tags", "styled.mx");
      const tag = "<div>\n  <html-style>a{}</html-style>\n</div>\n";
      writeFileSync(path, tag);
      let error: { message: string; line?: number; column?: number } = {
        message: "",
      };
      try {
        compileTagModule(tag, path);
      } catch (e) {
        error = e as typeof error;
      }
      expect(strip(error.message)).toMatch(/^`<html-style>` cannot be emitted/);
      expect(error).toMatchObject({ line: 2, column: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
