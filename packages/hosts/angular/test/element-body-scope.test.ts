// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A tag variable is scoped to the body that declares it (stock Marko 6.4.4:
 * `<const/count=1/><div><const/count=2/>${count}</div>${count}` reads `2` in
 * the `<div>` and `1` after it, as it does in an `<if>`, `<for>`, `<try>` or
 * `<define>` body). Angular scopes a `@let` to the view, not to an element, so
 * a `<const>` written in a native element body gets a `@let` name of its own,
 * and the reads after it in that body are pointed at it. Without that, a
 * `<const>` in an element body collides with an outer or sibling one and every
 * read resolves to the first.
 *
 * Every case runs the emitted template through TestBed (JIT, dev mode, jsdom)
 * and reads the rendered DOM, first render and after an update.
 */
import "@angular/compiler";
import { NgTemplateOutlet } from "@angular/common";
import { Component, signal } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MxHandlers } from "../src/runtime.ts";
import { assertAngularParses, emit } from "./helpers.ts";

beforeAll(() => {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});

afterEach(() => TestBed.resetTestingModule());

class Probe extends MxHandlers {
  x = signal(7);
  clicks: string[] = [];
  log = (value: unknown): void => {
    this.clicks.push(String(value));
  };
}

let counter = 0;

function mount(source: string) {
  const template = emit(source);
  assertAngularParses(template);
  class Page extends Probe {}
  counter += 1;
  Component({
    selector: `mx-element-body-scope-${counter}`,
    imports: [NgTemplateOutlet],
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

// [label, source, expected]. Expected is what stock 6.4.4 renders (inner
// reads the inner declaration, a read after the element reads the outer one).
const CASES: Array<[string, string, string]> = [
  [
    "an inner const shadows the outer one inside the element only",
    "<const/count=1/><div><const/count=2/>${count}</div>${count}",
    "<div>2</div>1",
  ],
  [
    "a read after the element is the outer binding",
    "<const/a=1/><div><const/a=2/></div>${a}",
    "<div></div>1",
  ],
  [
    "two elements deep, each level declaring the name",
    "<const/a=1/><div><section><const/a=2/>${a}</section>${a}</div>${a}",
    "<div><section>2</section>1</div>1",
  ],
  [
    "three levels, each declaring the name",
    "<const/a=1/><div><const/a=2/><section><const/a=3/><p>${a}</p></section>${a}</div>${a}",
    "<div><section><p>3</p></section>2</div>1",
  ],
  [
    "two sibling elements declare the same name",
    "<const/a=1/><div><const/a=2/>${a}</div><div><const/a=3/>${a}</div>${a}",
    "<div>2</div><div>3</div>1",
  ],
  [
    "sibling elements declare the same name with no outer one",
    "<div><const/a=2/>${a}</div><div><const/a=3/>${a}</div>",
    "<div>2</div><div>3</div>",
  ],
  [
    "a nested element that does not declare reads the enclosing body's name",
    "<const/a=1/><div><const/a=2/><section>${a}</section></div>${a}",
    "<div><section>2</section></div>1",
  ],
  [
    "the inner value is computed from the outer binding",
    "<const/a=1/><div><const/b=a+10/>${b}</div>${a}",
    "<div>11</div>1",
  ],
  [
    "a name declared only in the element body",
    "<div><const/x=1/>${x}</div>",
    "<div>1</div>",
  ],
  [
    "an element body inside an <if> body",
    "<const/a=1/><if=true><div><const/a=2/>${a}</div>${a}</if>${a}",
    "<div>2</div>1 1",
  ],
  [
    "an element body in each <for> iteration",
    "<const/a=1/><for|i| of=[1,2]><div><const/a=i/>${a}</div>${a}</for>${a}",
    "<div>1</div>1<div>2</div>1 1",
  ],
  [
    "a shorthand property and a template literal read the inner binding",
    "<const/a=1/><div><const/a=2/>${[{ a }][0].a}${`t${a}`}</div>${a}",
    "<div>2t2</div>1",
  ],
  [
    "a nested arrow parameter of the same name keeps its own binding",
    "<const/a=1/><div><const/a=2/>${[5].map((a) => a + 1).join()}${a}</div>${a}",
    "<div>62</div>1",
  ],
  [
    "a <define> written in two sibling element bodies",
    "<div><define/D>x</define><D/></div><div><define/D>y</define><D/></div>",
    "<div>x</div><div>y</div>",
  ],
  [
    "an inner <define> shadows an outer one of the same name",
    "<define/D>o</define><div><define/D>i</define><D/></div><D/>",
    "<div>i</div>o",
  ],
  [
    "an inner <define> in a nested element shadows one written in an element body",
    "<div><define/D>x</define><span><define/D>y</define><D/></span><D/></div>",
    "<div><span>y</span>x</div>",
  ],
  [
    "a <define> with a parameter written in an element body",
    "<define/D|v|>[${v}]</define><div><define/D|v|>(${v})</define><D(1)/></div><D(2)/>",
    "<div>(1)</div>[2]",
  ],
  [
    "concise syntax",
    "<const/a=1/>\ndiv\n  <const/a=2/>\n  -- ${a}\n-- ${a}",
    "<div>2</div>1",
  ],
];

describe("a tag variable is scoped to the native element body that declares it", () => {
  for (const [label, source, expected] of CASES) {
    it(label, () => {
      expect(mount(source).html()).toBe(expected);
    });
  }

  // A template reference or variable of the same name is in the same view as a
  // `@let`, and Angular refuses the pair (NG8017): the const is renamed.
  describe("beside an Angular template reference or variable of the same name", () => {
    it("an #a on an input renders the const", () => {
      expect(
        mount("<main><input #a/><div><const/a=1/>${a}</div></main>").html(),
      ).toBe("<main><input><div>1</div></main>");
    });
    it("a ref-a on an input renders the const", () => {
      expect(
        mount("<main><input ref-a/><div><const/a=1/>${a}</div></main>").html(),
      ).toBe("<main><input><div>1</div></main>");
    });
  });

  // Controls: these already scoped on main (their body is a view).
  describe("controls", () => {
    it("an <if> body", () => {
      expect(
        mount("<const/a=1/><if=true><const/a=2/>${a}</if>${a}").html(),
      ).toBe("2 1");
    });

    it("a <for> body", () => {
      expect(
        mount("<const/a=1/><for|i| of=[1]><const/a=2/>${a}</for>${a}").html(),
      ).toBe("2 1");
    });

    it("an element that declares nothing is emitted as before", () => {
      expect(emit("<div><p>${x()}</p></div>")).toBe(
        "<div><p>{{ x() }}</p></div>",
      );
    });
  });

  // A destructuring pattern lowers to one `<const>` per bound name
  // (`const-destructuring.test.ts`), so each name is renamed on a collision.
  describe("a destructuring <const> in an element body is one <const> per name", () => {
    const ROWS: Array<[string, string, string]> = [
      [
        "an object pattern",
        "<div><const/{ a, b }=o/>${a}${b}</div>",
        "<div>@let __mxPattern = o;@let a = __mxPattern.a;@let b = __mxPattern.b;{{ a }}{{ b }}</div>",
      ],
      [
        "an array pattern",
        "<div><const/[a, b]=[1,2]/>${a}${b}</div>",
        "<div>@let __mxPattern = [1,2];@let a = __mxPattern[0];@let b = __mxPattern[1];{{ a }}{{ b }}</div>",
      ],
      [
        "beside a const of the same name in the outer body",
        "<const/{ a }=o/><div><const/{ a, b }=p/>${a}${b}</div>${a}",
        "@let __mxPattern = o;@let a = __mxPattern.a;<div>@let __mxPattern1 = p;@let __mxConst_a = __mxPattern1.a;@let b = __mxPattern1.b;{{ __mxConst_a }}{{ b }}</div>{{ a }}",
      ],
      [
        "beside a plain const in the same body, which is renamed when its name is read outside",
        "<div><const/{ a }=o/><const/c=2/>${a}${c}</div>${c}",
        "<div>@let __mxPattern = o;@let a = __mxPattern.a;@let __mxConst_c = 2;{{ a }}{{ __mxConst_c }}</div>{{ c }}",
      ],
    ];
    for (const [label, source, expected] of ROWS) {
      it(label, () => {
        expect(emit(source)).toBe(expected);
      });
    }
  });

  // A diagnostic names the define the author wrote, not the generated name the
  // emitter gave it in an element body.
  describe("a <define> diagnostic in an element body names the define as written", () => {
    const ROWS: Array<[string, string, string]> = [
      [
        "a call with the wrong number of arguments",
        "<div><define/D|p|>${p.v}</define><D/></div>",
        "`<D>` expects 1 argument(s), got 0",
      ],
      [
        "a call with a body",
        "<div><define/D|p|>${p}</define><D(1)>body</D></div>",
        "body content on `<D>` isn't supported",
      ],
      [
        "a call with attribute tags",
        "<div><define/D>x</define><D><@x/></D></div>",
        "attribute tags on `<D>` aren't supported",
      ],
      [
        "the body of a define that has attributes",
        "<div><define/D a=1>x</define>${D.content}</div>",
        "`D.content` is the body of `<define/D>`",
      ],
      [
        "a whole read of a define that has attributes and a body",
        "<div><define/D a=1>x</define>${D}</div>",
        "`D` is read as a whole here, but `<define/D>` has attributes",
      ],
    ];
    // Alone the define keeps its authored name; beside an outer define of the
    // same name it is renamed, and the message still names what was written.
    for (const [prefix, when] of [
      ["", "alone"],
      ["<define/D>outer</define>", "beside an outer define of the same name"],
    ] as const) {
      for (const [label, source, expected] of ROWS) {
        it(`${label}, ${when}`, () => {
          let message = "";
          try {
            emit(prefix + source);
          } catch (error) {
            message = (error as Error).message;
          }
          expect(message).toContain(expected);
          expect(message).not.toContain("__mx");
        });
      }
    }
  });

  describe("after an update", () => {
    it("each read follows its own binding", () => {
      const { fixture, html, page } = mount(
        "<const/a=x()/><div><const/a=x()*2/>${a}</div>${a}",
      );
      expect(html()).toBe("<div>14</div>7");
      page.x.set(10);
      fixture.detectChanges();
      expect(html()).toBe("<div>20</div>10");
    });

    it("two sibling bodies follow their own bindings", () => {
      const { fixture, html, page } = mount(
        "<div><const/a=x()/>${a}</div><div><const/a=x()+1/>${a}</div>",
      );
      expect(html()).toBe("<div>7</div><div>8</div>");
      page.x.set(1);
      fixture.detectChanges();
      expect(html()).toBe("<div>1</div><div>2</div>");
    });
  });

  describe("an event handler reads the name where it is written", () => {
    it("inside the body it reads the inner binding, outside the outer one", () => {
      const { fixture, page } = mount(
        '<const/a=1/><div><const/a=2/><button id="in" onClick=(() => log(a))>i</button></div><button id="out" onClick=(() => log(a))>o</button>',
      );
      const root = fixture.nativeElement as HTMLElement;
      (root.querySelector("#in") as HTMLElement).click();
      (root.querySelector("#out") as HTMLElement).click();
      expect(page.clicks).toEqual(["2", "1"]);
    });
  });

  // A control-flow block projects into `<ng-content select>` by its single
  // root only, so a body must not be wrapped: a hand-written component called
  // by selector keeps its named slots.
  describe("a hand-written component called by selector keeps its slots", () => {
    const CARD = `[<ng-content select="[h]"></ng-content>]D(<ng-content></ng-content>)`;

    function mountWithCard(source: string): string {
      const template = emit(source);
      assertAngularParses(template);
      class Card {}
      counter += 1;
      Component({
        selector: "mx-card, [card]",
        template: CARD,
      })(Card);
      class Page extends Probe {}
      Component({
        selector: `mx-element-body-scope-${counter}`,
        imports: [Card],
        template,
      })(Page);
      const fixture = TestBed.createComponent(Page);
      fixture.detectChanges();
      return (fixture.nativeElement as HTMLElement).innerHTML
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/=""/g, "")
        .trim();
    }

    const BODY = "<const/a=1/><b h>${a}</b><i>body</i>";

    it("as a custom element, with a declaring body of two roots", () => {
      expect(mountWithCard(`<mx-card>${BODY}</mx-card>`)).toBe(
        "<mx-card>[<b h>1</b>]D(<i>body</i>)</mx-card>",
      );
    });

    it("as an attribute-selector host on a native tag", () => {
      expect(mountWithCard(`<div card>${BODY}</div>`)).toBe(
        "<div card>[<b h>1</b>]D(<i>body</i>)</div>",
      );
    });

    it("when the body shadows an outer name", () => {
      expect(
        mountWithCard(
          "<const/a=0/><mx-card><const/a=1/><b h>${a}</b><i>body ${a}</i></mx-card>${a}",
        ),
      ).toBe("<mx-card>[<b h>1</b>]D(<i>body 1</i>)</mx-card>0");
      expect(
        mountWithCard(
          "<const/a=0/><div card><const/a=1/><b h>${a}</b><i>body ${a}</i></div>${a}",
        ),
      ).toBe("<div card>[<b h>1</b>]D(<i>body 1</i>)</div>0");
    });
  });
});
