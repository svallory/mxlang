import { describe, expect, it } from "vitest";
import { compileNgMx } from "../src/ng-mx.ts";
import { compileMx } from "./helpers.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const lit = (source: string) =>
  compileMx(source).warnings.filter(
    (w) => (w as { code?: string }).code === "mx-angular-literal-syntax",
  );
const plain = (s: string) => s.replace(ANSI, "");

describe("literal Angular syntax in a template", () => {
  it("a17: `{{ x }}` warns at the braces with the `${…}` hint", () => {
    const w = lit("<div><p>{{ title }}</p></div>");
    expect(w).toHaveLength(1);
    expect(plain(w[0]?.message ?? "")).toBe(
      "`{{ title }}` is literal text in an MX template, not an Angular interpolation. Write `${title}`.",
    );
    expect([w[0]?.line, w[0]?.column]).toEqual([1, 8]);
  });

  it("a15: `@if (x) {` on its own line warns at the `@`", () => {
    const w = lit("<div>\n  @if (title) {\n    <p>x</p>\n  }\n</div>");
    expect(w).toHaveLength(1);
    expect(plain(w[0]?.message ?? "")).toBe(
      "`@if (title)…` is literal text in an MX template, not Angular control flow. Use `<if=title>…</if>`.",
    );
    expect([w[0]?.line, w[0]?.column]).toEqual([2, 2]);
  });

  it("a25: `@for` inside an `<if>` warns with the `<for|…|>` hint", () => {
    const w = lit(
      "<ul><li><if=i>@for (j of items; track j) { x }</if></li></ul>",
    );
    expect(w).toHaveLength(1);
    expect(plain(w[0]?.message ?? "")).toBe(
      "`@for (j of items; track j)…` is literal text in an MX template, not Angular control flow. Use `<for|j| of=items>…</for>`.",
    );
    expect([w[0]?.line, w[0]?.column]).toEqual([1, 14]);
  });

  it("`@switch` hints at an if/else-if chain; `@else` at `<else>`", () => {
    const sw = lit("<div>@switch (k) { x }</div>");
    expect(plain(sw[0]?.message ?? "")).toContain("`<else if=…>` chains");
    const el = lit("<div><p>a</p> @else { <p>b</p> }</div>");
    expect(plain(el[0]?.message ?? "")).toContain("`<else>…</else>`");
  });

  it("the position survives collapsed whitespace and later lines", () => {
    const w = lit("<div>\n  <p>a</p>\n  text   {{ a }}\n</div>");
    expect([w[0]?.line, w[0]?.column]).toEqual([3, 9]);
  });

  it("several matches in one run each get a warning", () => {
    expect(lit("<p>{{ a }} and {{ b }}</p>")).toHaveLength(2);
  });

  describe("no false positives", () => {
    it.each([
      ["expression attribute value", "<div title=`{{x}}`></div>"],
      ["string attribute value", '<div title="{{x}}"></div>'],
      ["placeholder escape", '<p>${"{{ x }}"}</p>'],
      ["placeholder escape of @if", '<p>${"@if (x) {"}</p>'],
      ["html comment", "<div><!-- {{ x }} @if (y) { --></div>"],
      ["lone braces in prose", "<p>a { b } c</p>"],
      ["lone opening pair", "<p>{{ not closed</p>"],
      ["email", "<p>mail user@host.com or me@if.example</p>"],
      ["prose at-word", "<p>the @if keyword and @for too</p>"],
      ["at-sign alone", "<p>@ home</p>"],
      ["handle", "<p>follow @elseware (ok)</p>"],
    ])("%s", (_name, src) => {
      expect(lit(src)).toEqual([]);
    });

    it("script/style content", () => {
      for (const src of [
        "<div><style>.a { color: red } /* {{ x }} */</style></div>",
        "<div><script>const a = '{{ x }}'</script></div>",
      ]) {
        let warnings: unknown[] = [];
        try {
          warnings = lit(src);
        } catch {
          // The host may reject the tag outright; either way no lint fires.
        }
        expect(warnings).toEqual([]);
      }
    });
  });
});

describe("literal Angular syntax in a .ng.mx region", () => {
  const file = (template: string) =>
    [
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      '  selector: "app-x",',
      `  template: ${template},`,
      "})",
      "export class XComponent { title = 'hi'; items = [1]; }",
    ].join("\n");
  const warnings = (template: string) =>
    compileNgMx(file(template), "x.component.ng.mx").warnings.filter(
      (w) => (w as { code?: string }).code === "mx-angular-literal-syntax",
    );

  it("a17: positions are file-relative", () => {
    const w = warnings("<div><p>{{ title }}</p></div>");
    expect(w).toHaveLength(1);
    expect([w[0]?.line, w[0]?.column]).toEqual([5, 20]);
  });

  it("a15: a block on a later line of the region", () => {
    const w = warnings(
      "<div>\n    @if (title) {\n      <p>x</p>\n    }\n  </div>",
    );
    expect(w).toHaveLength(1);
    expect([w[0]?.line, w[0]?.column]).toEqual([6, 4]);
  });

  it("a25: `@for` inside an `<if>` beside a `*ngFor`", () => {
    const w = warnings(
      '<ul><li *ngFor="let i of items"><if=i>@for (j of items; track j) { x }</if></li></ul>',
    );
    expect(w).toHaveLength(1);
    expect([w[0]?.line, w[0]?.column]).toEqual([5, 50]);
  });

  it("a clean region warns nothing", () => {
    expect(warnings("<div><if=title>${title}</if></div>")).toEqual([]);
  });
});
