// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX source
import { join, resolve } from "node:path";
import { parseTemplate } from "@angular/compiler";
import { describe, expect, it } from "vitest";
import { compileNgMx } from "../src/ng-mx.ts";

/**
 * `<html-script>` is the tag for a native html `<script>` element. Angular's
 * template compiler removes every `<script>` element, so no Angular output can
 * put one on the page: the host refuses the tag, once, at its name, with the
 * ways Angular does load a script. (Stock Marko, and the other hosts, write
 * a real `<script>`.)
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
