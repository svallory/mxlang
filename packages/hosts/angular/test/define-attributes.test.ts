// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * Marko makes a `<define>` tag's attributes properties of its value
 * (`<define/D a=1/>`, then `${D.a}` reads `1`). On this host a define is an
 * `<ng-template #D>`, a template reference with no properties, so the
 * attributes used to be refused at the first one. They are lowered now: the
 * attributes ride a `@let` of their own, declared where the define is, and
 * every later read of `D` is a read of that `@let`.
 *
 * Every render case runs the emitted template through TestBed (JIT, jsdom).
 * The expected HTML is what stock Marko 6.4.4 and `@mxlang/target-html`
 * render for the same source (probed with `bun run --cwd
 * packages/stock-marko probe` and a stock render).
 */
import "@angular/compiler";
import { NgTemplateOutlet } from "@angular/common";
import { Component } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertAngularParses, emit } from "./helpers.ts";

beforeAll(() => {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});

afterEach(() => TestBed.resetTestingModule());

let counter = 0;

/** Renders an emitted template in a component whose `input` mirrors the tests' `INPUT`. */
function render(source: string): string {
  const template = emit(source);
  assertAngularParses(template);
  class Probe {
    input = {
      x: 7,
      rest: { a: 1, b: 2 },
      items: [1, 2],
      show: true,
      label: "L",
    };
    log: string[] = [];
    tick = (label: string, value: unknown) => {
      this.log.push(label);
      return value;
    };
  }
  counter += 1;
  Component({
    selector: `mx-define-attrs-${counter}`,
    imports: [NgTemplateOutlet],
    template,
  })(Probe);
  const fixture = TestBed.createComponent(Probe);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).innerHTML
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(source: string): any {
  try {
    emit(source);
  } catch (error) {
    return error;
  }
  return undefined;
}

// [label, source, expected]. Expected is stock Marko 6.4.4's render.
const CASES: Array<[string, string, string]> = [
  ["a static attribute", "<define/D a=1/>${D.a}", "1"],
  ["a dynamic attribute", "<define/D a=input.x/><p>${D.a}</p>", "<p>7</p>"],
  [
    "a string and a number",
    '<define/D s="x" n=4/><p>${D.s}${D.n}</p>',
    "<p>x4</p>",
  ],
  [
    "a string holding the characters a @let ends on",
    '<define/D s="a;b }" /><p>${D.s}</p>',
    "<p>a;b }</p>",
  ],
  [
    "attributes with params, read",
    "<define/D|v| a=1><b>${v}</b></define><p>${D.a}</p>",
    "<p>1</p>",
  ],
  [
    "attributes with params, called",
    "<define/D|v| a=1><b>${v}</b></define><p>${D.a}</p><D(5)/>",
    "<p>1</p><b>5</b>",
  ],
  ["a spread", "<define/D ...input.rest/><p>${D.a}-${D.b}</p>", "<p>1-2</p>"],
  [
    "a spread beside an attribute",
    "<define/D z=0 ...input.rest/><p>${D.z}${D.a}${D.b}</p>",
    "<p>012</p>",
  ],
  [
    "two defines",
    "<define/A a=1/><define/B b=2/><p>${A.a}${B.b}</p>",
    "<p>12</p>",
  ],
  [
    "a later define reads an earlier one",
    "<define/A a=1/><define/B b=A.a/><p>${A.a}${B.b}</p>",
    "<p>11</p>",
  ],
  [
    "the define's own body reads its attributes",
    "<define/D a=1>${D.a}</define><D/>",
    "1",
  ],
  [
    "the define's own body reads a dynamic attribute and a param",
    "<define/D|v| a=input.x><b>${D.a}${v}</b></define><D(2)/>",
    "<b>72</b>",
  ],
  [
    "a param named like the define shadows it in the define's body",
    "<define/D|D| a=1>${D}</define><D(5)/>",
    "5",
  ],
  [
    "a define nested in the define's body reads the outer attributes",
    "<define/D a=1><define/E b=D.a/>${E.b}</define><D/>",
    "1",
  ],
  [
    "a dynamic attribute read twice is evaluated once in a pass",
    '<define/D a=tick("a", 1)/><p>${D.a}${D.a}</p><i>${log.join()}</i>',
    "<p>11</p><i>a</i>",
  ],
  [
    "a dynamic attribute nothing reads is still evaluated once in a pass",
    '<define/D a=tick("a", 1)/><p>hi</p><i>${log.join()}</i>',
    "<p>hi</p><i>a</i>",
  ],
  [
    "a dynamic attribute is evaluated at the define, before a later placeholder",
    '<define/D a=tick("a", 1)/><p>${tick("p", 0)}</p><p>${D.a}</p><i>${log.join()}</i>',
    "<p>0</p><p>1</p><i>a,p</i>",
  ],
  [
    "an object attribute has one identity across reads",
    '<define/D o={}/><p>${D.o === D.o ? "same" : "different"}</p>',
    "<p>same</p>",
  ],
  ["concise mode", "define/D a=1\np -- ${D.a}", "<p>1</p>"],
  [
    "in an element body",
    "<div><define/D a=1/><p>${D.a}</p></div>",
    "<div><p>1</p></div>",
  ],
  [
    "a boolean attribute",
    "<define/D disabled/><p>${D.disabled ? 'yes' : 'no'}</p>",
    "<p>yes</p>",
  ],
  [
    "a content attribute with no body",
    "<define/D content=1/><p>${D.content}</p>",
    "<p>1</p>",
  ],
  [
    "a hoisted-style define reads another define's attribute",
    "<define/D a=1/><define/E><i>${D.a}</i></define><E/>",
    "<i>1</i>",
  ],
  [
    "a param that shares the define's name shadows it",
    "<define/D a=1/><define/E|D|>${D}</define><E(5)/>",
    "5",
  ],
  [
    "an attribute that is never read",
    "<define/D a=input.x/><p>hi</p>",
    "<p>hi</p>",
  ],
  [
    "nested in a <for>, a row's attribute",
    "<for|n| of=input.items><define/D a=n/><p>${D.a}</p></for>",
    "<p>1</p><p>2</p>",
  ],
  [
    "nested in a <for>, reading the row and the outer input",
    "<for|n| of=input.items><define/D a=n b=input.x/><p>${D.a}${D.b}</p></for>",
    "<p>17</p><p>27</p>",
  ],
  [
    "nested in an <if>",
    "<if=input.show><define/D a=input.x/><p>${D.a}</p></if>",
    "<p>7</p>",
  ],
  [
    "read from inside a <for> row",
    "<define/D a=input.x/><for|n| of=input.items><p>${D.a}${n}</p></for>",
    "<p>71</p><p>72</p>",
  ],
];

describe("angular: a <define>'s attributes are properties of its value", () => {
  it.each(CASES)("%s", (_label, source, expected) => {
    expect(render(source)).toBe(expected);
  });

  it("emits the attributes as a @let beside the template reference", () => {
    const out = emit("<define/Row n=1 label=input.label>x</define>${Row.n}");
    expect(out).toBe(
      '@let __mxDefine = { "n": 1, "label": input.label }; <ng-template #Row> x </ng-template>{{ __mxDefine.n }}',
    );
    assertAngularParses(out);
  });

  it("gives each attributed define its own @let", () => {
    const out = emit("<define/A a=1/><define/B a=2/>${A.a}${B.a}");
    expect(out).toContain('@let __mxDefine = { "a": 1 };');
    expect(out).toContain('@let __mxDefine1 = { "a": 2 };');
    expect(out).toContain("{{ __mxDefine.a }}{{ __mxDefine1.a }}");
  });
});

describe("angular: what stays refused", () => {
  it("a bound attribute (a:=x) is refused at the attribute", () => {
    const source = "<define/D a:=input.x/><p>${D.a}</p>";
    const error = thrown(source);
    expect(error.message).toBe(
      "bound attribute (`:=`) is Marko reactive state; use a signal and an explicit event handler",
    );
    expect([error.line, error.column]).toEqual([1, source.indexOf("a:=")]);
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
  });

  it("D.content of a define that has attributes and a body is refused, at the read", () => {
    const source = "<define/D a=1><i>b</i></define><p>${typeof D.content}</p>";
    const error = thrown(source);
    expect(error.message).toBe(
      "`D.content` is the body of `<define/D>`, which a define with attributes cannot expose in an Angular template: `#D` is a template reference. Call it as `<D/>`, or move the attributes to a second `<define>`",
    );
    expect([error.line, error.column]).toEqual([1, source.indexOf("${typeof")]);
    expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
  });

  // Every way to reach the body of a define that has attributes, other than a
  // plain `D.content`, was a silent wrong value before (stock: `function`,
  // `<i>b</i>`, a value carrying `.content`).
  it.each([
    ["a parenthesised D.content", "<p>${typeof (D).content}</p>", "content"],
    ["an optional D?.content", "<p>${typeof D?.content}</p>", "content"],
    ['a computed D["content"]', '<p>${typeof D["content"]}</p>', "content"],
    ["a dynamic tag <${D}/>", "<${D}/>", "whole"],
    ["a bare D in a placeholder", "<p>${typeof D}</p>", "whole"],
    ["a computed D[key]", "<p>${D[input.key]}</p>", "whole"],
    ["D as a call argument", "<define/E|v|>x</define><E(D)/>", "whole"],
    [
      "D read in the define's own body",
      "<define/F>${D.content}</define>",
      "content",
    ],
  ])(
    "%s is refused at the read when the define has a body",
    (_label, read, kind) => {
      const source = `<define/D a=1><i>b</i></define>${read}`;
      const error = thrown(source);
      expect(error.message).toBe(
        kind === "content"
          ? "`D.content` is the body of `<define/D>`, which a define with attributes cannot expose in an Angular template: `#D` is a template reference. Call it as `<D/>`, or move the attributes to a second `<define>`"
          : "`D` is read as a whole here, but `<define/D>` has attributes and a body, and in an Angular template only `D.<attribute>` can be read from it: `#D` is a template reference. Call it as `<D/>`, or move the attributes to a second `<define>`",
      );
      expect(error.line).toBe(1);
      expect(error.column).toBeGreaterThanOrEqual(source.indexOf(read));
      expect(error.diagnosticCode).toBe("MX_UNSUPPORTED_CONSTRUCT");
    },
  );

  it("the define's own body reading its own body is refused too", () => {
    const source = "<define/D a=1>${typeof D.content}</define>";
    expect(thrown(source).message).toContain("`D.content` is the body of");
  });

  it("a define with no body can be read as a whole", () => {
    expect(render("<define/D a=1/><p>${typeof D}${D === D}</p>")).toBe(
      "<p>objecttrue</p>",
    );
  });

  it("a define with a body and attributes is fine when nothing reads D.content", () => {
    expect(thrown("<define/D a=1><i>b</i></define><D/><p>${D.a}</p>")).toBe(
      undefined,
    );
  });

  it("assigning the define's name is refused", () => {
    const source =
      "<define/D a=1/><button onClick=() => D = 2>x</button><p>${D.a}</p>";
    expect(thrown(source).message).toBe(
      "`D` is a `<define>`'s value and cannot be assigned; read its attributes as `D.name`",
    );
  });

  it("an attribute that is a method keeps the statement-body error", () => {
    expect(
      thrown("<define/D f() { return 3 }/><p>${D.f()}</p>").message,
    ).toContain("Angular templates cannot contain a `function` expression");
  });

  it("a define with no attributes still compiles to a bare template", () => {
    expect(emit("<define/D><p>x</p></define><D/>")).not.toContain("@let");
  });
});
