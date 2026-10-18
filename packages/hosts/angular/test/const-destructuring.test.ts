// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `<const/{ a, b }=obj/>` and `<const/[x, y]=list/>`. Angular's `@let` takes
 * one name and a template expression cannot destructure, so a pattern lowers
 * to one generated `@let` that holds the initializer (evaluated once) and one
 * `@let` per bound name reading from it. Each bound name is an ordinary
 * `<const>` for the collision accounting: it keeps the name the author wrote
 * unless another declaration or a read outside its scope shares it, and is
 * then renamed with its reads.
 *
 * Stock Marko 6.4.4 compiles every pattern here (`bun run --cwd
 * packages/stock-marko probe`), except a computed key (`{ [k]: v }`: "Only
 * identifier and string literal keys are supported when destructuring"),
 * which MX refuses at the key. The rendered values are JavaScript's
 * destructuring semantics, which Marko emits as written.
 *
 * Render rows run the emitted template through TestBed (JIT, dev mode, jsdom),
 * first render and after an update.
 */
import "@angular/compiler";
import { Component, signal } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertAngularParses, compileMx, emit } from "./helpers.ts";

beforeAll(() => {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});

afterEach(() => TestBed.resetTestingModule());

class Probe {
  x = signal(7);
}

let counter = 0;

function mount(source: string) {
  const template = emit(source);
  assertAngularParses(template);
  class Page extends Probe {}
  counter += 1;
  Component({
    selector: `mx-const-destructuring-${counter}`,
    template,
  })(Page);
  const fixture = TestBed.createComponent(Page);
  fixture.detectChanges();
  const html = (): string =>
    (fixture.nativeElement as HTMLElement).innerHTML
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/>\s+/g, ">")
      .replace(/\s+</g, "<")
      .trim();
  return { fixture, html, page: fixture.componentInstance as Probe };
}

describe("the emitted template", () => {
  const ROWS: Array<[string, string, string]> = [
    [
      "an object pattern",
      "<const/{ a, b }=input.o/>${a}${b}",
      "@let __mxPattern = input.o;@let a = __mxPattern.a;@let b = __mxPattern.b;{{ a }}{{ b }}",
    ],
    [
      "an array pattern with a hole and a rest",
      "<const/[x, , y, ...r]=input.l/>${x}${y}${r}",
      "@let __mxPattern = input.l;@let x = __mxPattern[0];@let y = __mxPattern[2];@let r = __mxPattern.slice(3);{{ x }}{{ y }}{{ r }}",
    ],
    [
      "a renamed field",
      "<const/{ a: n }=input.o/>${n}",
      "@let __mxPattern = input.o;@let n = __mxPattern.a;{{ n }}",
    ],
    [
      "a string key",
      '<const/{ "a-b": c }=input.o/>${c}',
      '@let __mxPattern = input.o;@let c = __mxPattern["a-b"];{{ c }}',
    ],
    [
      "a nested pattern reads through the path",
      "<const/{ a: { b }, c: [d] }=input.o/>${b}${d}",
      "@let __mxPattern = input.o;@let b = __mxPattern.a.b;@let d = __mxPattern.c[0];{{ b }}{{ d }}",
    ],
    [
      "a default applies to undefined only",
      "<const/{ a = 1 }=input.o/>${a}",
      "@let __mxPattern = input.o;@let __mxPattern1 = __mxPattern.a;@let a = __mxPattern1 === undefined ? (1) : __mxPattern1;{{ a }}",
    ],
    [
      "a nested pattern with a default holds the defaulted value once",
      "<const/{ a: { b } = {} }=input.o/>${b}",
      "@let __mxPattern = input.o;@let __mxPattern1 = __mxPattern.a;@let __mxPattern2 = __mxPattern1 === undefined ? ({}) : __mxPattern1;@let b = __mxPattern2.b;{{ b }}",
    ],
    [
      "a conditional default is parenthesized",
      "<const/{ a = input.p ? 1 : 2 }=input.o/>${a}",
      "@let __mxPattern = input.o;@let __mxPattern1 = __mxPattern.a;@let a = __mxPattern1 === undefined ? (input.p ? 1 : 2) : __mxPattern1;{{ a }}",
    ],
    [
      "a nested pattern binding two names reads the field once",
      "<const/{ a: { b, c } }=input.o/>${b}${c}",
      "@let __mxPattern = input.o;@let __mxPattern1 = __mxPattern.a;@let b = __mxPattern1.b;@let c = __mxPattern1.c;{{ b }}{{ c }}",
    ],
    [
      "an empty pattern still evaluates the initializer",
      "<const/{}=input.o/>",
      "@let __mxPattern = input.o;",
    ],
    [
      "in an element body, beside an outer const of the same name",
      "<const/{ a }=input.o/><div><const/{ a, b }=input.p/>${a}${b}</div>${a}",
      "@let __mxPattern = input.o;@let a = __mxPattern.a;<div>@let __mxPattern1 = input.p;@let __mxConst_a = __mxPattern1.a;@let b = __mxPattern1.b;{{ __mxConst_a }}{{ b }}</div>{{ a }}",
    ],
    [
      "in an element body with no collision keeps every name",
      "<div><const/{ a, b }=input.o/>${a}${b}</div>",
      "<div>@let __mxPattern = input.o;@let a = __mxPattern.a;@let b = __mxPattern.b;{{ a }}{{ b }}</div>",
    ],
    [
      "a name read outside the body is renamed with its reads",
      "<div><const/{ a, b }=input.o/>${a}${b}</div>${b}",
      "<div>@let __mxPattern = input.o;@let a = __mxPattern.a;@let __mxConst_b = __mxPattern.b;{{ a }}{{ __mxConst_b }}</div>{{ b }}",
    ],
  ];
  for (const [label, source, expected] of ROWS) {
    it(label, () => {
      const out = emit(source);
      expect(out).toBe(expected);
      assertAngularParses(out);
    });
  }

  it("evaluates the initializer once, however many names the pattern binds", () => {
    const out = emit("<const/{ a, b, c }=input.next()/>${a}${b}${c}");
    expect(out.split("input.next()")).toHaveLength(2);
  });
});

describe("the rendered values", () => {
  // [label, source, first render (x = 7), after x.set(9)]
  const CASES: Array<[string, string, string, string]> = [
    [
      "an object pattern",
      "<const/{ a, b }={ a: x(), b: 2 }/>${a}-${b}",
      "7-2",
      "9-2",
    ],
    ["an array pattern", "<const/[p, q]=[x(), 2]/>${p}-${q}", "7-2", "9-2"],
    ["a hole skips an element", "<const/[, q]=[x(), 2]/>${q}", "2", "2"],
    [
      "an array rest",
      "<const/[h, ...t]=[x(), 2, 3]/>${h}:${t.join()}",
      "7:2,3",
      "9:2,3",
    ],
    [
      "a default fills a missing field and a present one wins",
      "<const/{ a = 1, b = 2 }={ a: x() }/>${a}-${b}",
      "7-2",
      "9-2",
    ],
    [
      "a default does not apply to null",
      "<const/{ a = 1 }={ a: null }/>${a === null}",
      "true",
      "true",
    ],
    [
      "a default reads an earlier name of the pattern",
      "<const/{ a, b = a }={ a: x() }/>${a},${b}",
      "7,7",
      "9,9",
    ],
    ["a renamed field", "<const/{ a: n }={ a: x() }/>${n}", "7", "9"],
    ["a string key", '<const/{ "a-b": c }={ "a-b": x() }/>${c}', "7", "9"],
    [
      "a nested object pattern",
      "<const/{ a: { b } }={ a: { b: x() } }/>${b}",
      "7",
      "9",
    ],
    [
      "a nested pattern with a default",
      "<const/{ a: { b } = { b: 5 } }={}/>${b}",
      "5",
      "5",
    ],
    [
      "an array inside an object",
      "<const/{ l: [first, second] }={ l: [x(), 2] }/>${first}${second}",
      "72",
      "92",
    ],
    [
      "an inner pattern shadows an outer const inside the element only",
      "<const/a=1/><div><const/{ a, b }={ a: x(), b: 2 }/>${a}${b}</div>${a}",
      "<div>72</div>1",
      "<div>92</div>1",
    ],
    [
      "an inner pattern shadows an outer pattern",
      "<const/{ a }={ a: 1 }/><div><const/{ a }={ a: x() }/>${a}</div>${a}",
      "<div>7</div>1",
      "<div>9</div>1",
    ],
    [
      "two sibling elements bind the same names",
      "<div><const/{ a }={ a: 1 }/>${a}</div><div><const/{ a }={ a: x() }/>${a}</div>",
      "<div>1</div><div>7</div>",
      "<div>1</div><div>9</div>",
    ],
    [
      "a pattern in a <for> body binds per row",
      "<for|i| of=[1, 2]><const/{ v }={ v: i * x() }/><span>${v}</span></for>",
      "<span>7</span><span>14</span>",
      "<span>9</span><span>18</span>",
    ],
    [
      "a plain const reads a pattern name",
      "<const/{ a }={ a: x() }/><const/d=a + 1/>${d}",
      "8",
      "10",
    ],
  ];
  for (const [label, source, first, updated] of CASES) {
    it(label, () => {
      const { fixture, html, page } = mount(source);
      expect(html().replace(/ /g, "")).toBe(first.replace(/ /g, ""));
      page.x.set(9);
      fixture.detectChanges();
      expect(html().replace(/ /g, "")).toBe(updated.replace(/ /g, ""));
    });
  }
});

describe("a form Angular cannot express is refused at the <const>", () => {
  function refusal(source: string) {
    try {
      compileMx(source);
    } catch (error) {
      return error as Error & { line?: number; column?: number };
    }
    throw new Error(`expected a refusal for ${source}`);
  }

  // [label, source, message needle, line, column]: the position is the
  // refused part of the pattern (`...rest`, `[k]`), not the tag.
  const ROWS: Array<[string, string, string, number, number]> = [
    [
      "an object rest",
      "<const/{ a, ...rest }=input.o/>${a}",
      "object rest",
      1,
      12,
    ],
    [
      "an object rest in an element body",
      "<div>\n  <const/{ a, ...rest }=input.o/>${a}\n</div>",
      "object rest",
      2,
      14,
    ],
    [
      "an object rest in a nested pattern",
      "<main>\n<div>\n  <const/{ a: { ...rest } }=input.o/>${rest}\n</div></main>",
      "object rest",
      3,
      16,
    ],
    [
      "a computed key",
      "<const/{ [input.k]: v }=input.o/>${v}",
      "computed key",
      1,
      9,
    ],
    [
      "a computed key naming a const",
      "<const/k='a'/>\n<const/{ [k]: v }=input.o/>${v}",
      "computed key",
      2,
      9,
    ],
    [
      "a computed key in a nested pattern",
      "<div>\n  <const/{ a: { [k]: v } }=input.o/>${v}\n</div>",
      "computed key",
      2,
      16,
    ],
  ];
  for (const [label, source, needle, line, column] of ROWS) {
    it(label, () => {
      const error = refusal(source);
      expect(error.message).toContain(needle);
      expect(error).toMatchObject({ line, column });
    });
  }
});
