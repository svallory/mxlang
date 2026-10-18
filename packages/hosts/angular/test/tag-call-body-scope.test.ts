// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A tag variable is scoped to the body that declares it, an MX tag call's body
 * and an attribute tag's body included (stock Marko 6.4.4:
 * `<const/a=1/><card><const/a=2/>${a}</card>${a}` renders `<section>2</section>1`).
 *
 * The body of `<Card>…</Card>` is projected content written in the caller's
 * template, so its `@let` shares the caller's view like one in a native element
 * body. It keeps the name the author wrote unless that name collides, and is
 * renamed (`__mxConst_<name>`) only then, the same rule as an element body.
 *
 * The expected render strings are what stock Marko 6.4.4 renders for the same
 * source with a `card` tag of `<section><${input.content}/></section>` and a
 * `hello` tag of `<div class="h"><${input.header}/>|<${input.content}/></div>`.
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
import { assertAngularParses, emitWithTags } from "./helpers.ts";

beforeAll(() => {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});

afterEach(() => TestBed.resetTestingModule());

class Probe extends MxHandlers {
  x = signal(7);
}

class Card {}
Component({
  selector: "mx-card",
  template: "<section><ng-content></ng-content></section>",
})(Card);

class Hello {}
Component({
  selector: "mx-hello",
  template:
    '<div class="h"><ng-content select="[header]"></ng-content>|<ng-content></ng-content></div>',
})(Hello);

const TAGS = ["Card", "Hello"];
let counter = 0;

function mount(source: string) {
  const template = emitWithTags(source, TAGS);
  assertAngularParses(template);
  class Page extends Probe {}
  counter += 1;
  Component({
    selector: `mx-tag-call-body-scope-${counter}`,
    imports: [Card, Hello, NgTemplateOutlet],
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

// [label, source, expected render (stock Marko 6.4.4)]
const RENDER: Array<[string, string, string]> = [
  [
    "an inner const shadows the outer one inside the tag call only",
    "<const/a=1/><Card><const/a=2/>${a}</Card>${a}",
    "<mx-card><section>2</section></mx-card>1",
  ],
  [
    "a name declared only in the tag call body",
    "<Card><const/a=2/>${a}</Card>",
    "<mx-card><section>2</section></mx-card>",
  ],
  [
    "two sibling tag calls declare the same name",
    "<const/a=1/><Card><const/a=2/>${a}</Card><Card><const/a=3/>${a}</Card>${a}",
    "<mx-card><section>2</section></mx-card><mx-card><section>3</section></mx-card>1",
  ],
  [
    "a tag call nested in a tag call, each declaring the name",
    "<const/a=1/><Card><const/a=2/><Card><const/a=3/>${a}</Card>${a}</Card>${a}",
    "<mx-card><section><mx-card><section>3</section></mx-card>2</section></mx-card>1",
  ],
  [
    "a native element in the tag call body declares the name again",
    "<const/a=1/><Card><const/a=2/><div><const/a=3/>${a}</div>${a}</Card>${a}",
    "<mx-card><section><div>3</div>2</section></mx-card>1",
  ],
  [
    "a <define> written in a tag call body, beside one of the same name outside",
    "<define/D>o</define><Card><define/D>i</define><D/></Card><D/>",
    "<mx-card><section>i</section></mx-card>o",
  ],
  [
    "a const inside a <define> body in a tag call body",
    "<const/a=1/><Card><define/D><const/a=5/><b>${a}</b></define><D/><i>${a}</i></Card>${a}",
    "<mx-card><section><b>5</b><i>1</i></section></mx-card>1",
  ],
  [
    "an attribute tag body shadows the outer name, beside a default body that declares it too",
    "<const/a=1/><Hello><@header><const/a=2/>${a}</@header><const/a=3/>${a}</Hello>${a}",
    '<mx-hello><div class="h">2|3</div></mx-hello>1',
  ],
  [
    "an attribute tag body with a nested element",
    "<const/a=1/><Hello><@header><const/a=2/><b>${a}</b></@header><const/b=3/><i>${a}${b}</i></Hello>${a}",
    '<mx-hello><div class="h"><b>2</b>|<i>13</i></div></mx-hello>1',
  ],
  [
    "two tag calls whose attribute tag bodies declare the same name",
    "<const/a=1/><Hello><@header><const/a=2/>${a}</@header><const/a=3/>${a}</Hello><Hello><@header><const/a=4/>${a}</@header><const/a=5/>${a}</Hello>${a}",
    '<mx-hello><div class="h">2|3</div></mx-hello><mx-hello><div class="h">4|5</div></mx-hello>1',
  ],
  [
    "an attribute tag body alone",
    "<Hello><@header><const/a=2/>${a}</@header>x</Hello>",
    '<mx-hello><div class="h">2|x</div></mx-hello>',
  ],
  [
    "a tag call body inside a native element body, both declaring the name",
    "<const/a=1/><div><const/a=2/><Card><const/a=3/>${a}</Card>${a}</div>${a}",
    "<div><mx-card><section>3</section></mx-card>2</div>1",
  ],
];

describe("a tag variable is scoped to the tag call body that declares it", () => {
  for (const [label, source, expected] of RENDER) {
    it(label, () => {
      expect(mount(source).html()).toBe(expected);
    });
  }

  describe("after an update", () => {
    it("each read follows its own binding", () => {
      const { fixture, html, page } = mount(
        "<const/a=x()/><Card><const/a=x()*2/>${a}</Card>${a}",
      );
      expect(html()).toBe("<mx-card><section>14</section></mx-card>7");
      page.x.set(10);
      fixture.detectChanges();
      expect(html()).toBe("<mx-card><section>20</section></mx-card>10");
    });

    it("two sibling tag calls follow their own bindings", () => {
      const { fixture, html, page } = mount(
        "<Card><const/a=x()/>${a}</Card><Card><const/a=x()+1/>${a}</Card>",
      );
      expect(html()).toBe(
        "<mx-card><section>7</section></mx-card><mx-card><section>8</section></mx-card>",
      );
      page.x.set(1);
      fixture.detectChanges();
      expect(html()).toBe(
        "<mx-card><section>1</section></mx-card><mx-card><section>2</section></mx-card>",
      );
    });

    it("an attribute tag body follows its own binding", () => {
      const { fixture, html, page } = mount(
        "<const/a=x()/><Hello><@header><const/a=x()*2/>${a}</@header><const/a=x()+1/>${a}</Hello>${a}",
      );
      expect(html()).toBe('<mx-hello><div class="h">14|8</div></mx-hello>7');
      page.x.set(10);
      fixture.detectChanges();
      expect(html()).toBe('<mx-hello><div class="h">20|11</div></mx-hello>10');
    });
  });

  // Named slots are the reason no `@if (true) { … }` view wraps a body: a
  // control-flow block projects by its single root only.
  describe("named slot projection survives a renamed declaration", () => {
    it("the header and default content land in their slots", () => {
      expect(
        mount(
          "<const/a=1/><Hello><@header><b>H${a}</b></@header><const/a=2/><i>B${a}</i><u>C${a}</u></Hello>${a}",
        ).html(),
      ).toBe(
        '<mx-hello><div class="h"><b>H1</b>|<i>B2</i><u>C2</u></div></mx-hello>1',
      );
    });
  });
});

// [label, source, expected template]
const AUTHORED: Array<[string, string, string]> = [
  [
    "a name declared only in the tag call body",
    "<Card><const/a=2/>${a}</Card>",
    "<mx-card>@let a = 2;{{ a }}</mx-card>",
  ],
  [
    "a name declared only in an attribute tag body",
    "<Card><@header><const/a=2/>${a}</@header></Card>",
    '<mx-card><ng-container ngProjectAs="[header]">@let a = 2;{{ a }}</ng-container></mx-card>',
  ],
  [
    "a const unread and alone in the tag call body",
    "<Card><const/a=2/></Card>",
    "<mx-card>@let a = 2;</mx-card>",
  ],
  [
    "different names in sibling tag call bodies",
    "<Card><const/a=2/>${a}</Card><Card><const/b=3/>${b}</Card>",
    "<mx-card>@let a = 2;{{ a }}</mx-card><mx-card>@let b = 3;{{ b }}</mx-card>",
  ],
];

// [label, source, expected template]
const RENAMED: Array<[string, string, string]> = [
  [
    "an inner const shadows an outer one",
    "<const/a=1/><Card><const/a=2/>${a}</Card>${a}",
    "@let a = 1;<mx-card>@let __mxConst_a = 2;{{ __mxConst_a }}</mx-card>{{ a }}",
  ],
  [
    "two sibling tag calls declare the same name",
    "<Card><const/a=2/>${a}</Card><Card><const/a=3/>${a}</Card>",
    "<mx-card>@let __mxConst_a = 2;{{ __mxConst_a }}</mx-card><mx-card>@let __mxConst_a1 = 3;{{ __mxConst_a1 }}</mx-card>",
  ],
  [
    "the name is read after the tag call",
    "<Card><const/a=2/>${a}</Card>${a}",
    "<mx-card>@let __mxConst_a = 2;{{ __mxConst_a }}</mx-card>{{ a }}",
  ],
  [
    "an inner const shadows an outer one in an attribute tag body",
    "<const/a=1/><Card><@header><const/a=2/>${a}</@header></Card>${a}",
    '@let a = 1;<mx-card><ng-container ngProjectAs="[header]">@let __mxConst_a = 2;{{ __mxConst_a }}</ng-container></mx-card>{{ a }}',
  ],
  [
    "an attribute tag body and the default body declare the same name",
    "<Card><@header><const/a=2/>${a}</@header><const/a=3/>${a}</Card>",
    '<mx-card><ng-container ngProjectAs="[header]">@let __mxConst_a1 = 2;{{ __mxConst_a1 }}</ng-container>@let __mxConst_a = 3;{{ __mxConst_a }}</mx-card>',
  ],
  [
    "an attribute tag body in a conditional projection",
    "<const/a=1/><Card><if=true><@header><const/a=2/>${a}</@header></if></Card>${a}",
    '@let a = 1;<mx-card>@if (true) { <ng-container ngProjectAs="[header]">@let __mxConst_a = 2;{{ __mxConst_a }}</ng-container> }</mx-card>{{ a }}',
  ],
  [
    "a <define> written in a tag call body beside one of the same name outside",
    "<define/D>o</define><Card><define/D>i</define><D/></Card><D/>",
    '<ng-template #D> o </ng-template><mx-card><ng-template #__mxDefine_D> i </ng-template><ng-container [ngTemplateOutlet]="__mxDefine_D" [ngTemplateOutletContext]="{}"></ng-container></mx-card><ng-container [ngTemplateOutlet]="D" [ngTemplateOutletContext]="{}"></ng-container>',
  ],
  [
    "an Angular template reference has the name",
    "<main><input #a/><Card><const/a=1/>${a}</Card></main>",
    "<main><input #a><mx-card>@let __mxConst_a = 1;{{ __mxConst_a }}</mx-card></main>",
  ],
  [
    "a tag call body inside an element body, both declaring the name",
    "<div><const/a=1/><Card><const/a=2/>${a}</Card>${a}</div>",
    "<div>@let __mxConst_a = 1;<mx-card>@let __mxConst_a1 = 2;{{ __mxConst_a1 }}</mx-card>{{ __mxConst_a }}</div>",
  ],
];

describe("emitted template: a tag call body declaration keeps its name unless it collides", () => {
  describe("no collision: the authored name", () => {
    for (const [label, source, expected] of AUTHORED) {
      it(label, () => {
        expect(emitWithTags(source, TAGS)).toBe(expected);
      });
    }
  });

  describe("a collision: a name of its own", () => {
    for (const [label, source, expected] of RENAMED) {
      it(label, () => {
        const template = emitWithTags(source, TAGS);
        assertAngularParses(template);
        expect(template).toBe(expected);
      });
    }
  });
});
