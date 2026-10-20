// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * A `<const>` or `<define>` written in a native element body keeps the name
 * the author wrote unless that name is also declared or read somewhere else in
 * the template. Angular scopes a `@let` to a view and an element opens none,
 * so only then do two of them share a view and one must get a name of its own
 * (`__mxConst_<name>` / `__mxDefine_<name>`).
 *
 * The expected strings for the unrenamed cases are what the emitter wrote
 * before the rename existed (99c6cc3f), so an Angular diagnostic that quotes
 * the `@let` or the `#ref` quotes the author's name.
 */
import { describe, expect, it } from "vitest";
import { emit } from "./helpers.ts";

// [label, source, expected template]
const AUTHORED: Array<[string, string, string]> = [
  [
    "a lone const in a single root",
    "<section><const/a=1/></section>",
    "<section>@let a = 1;</section>",
  ],
  [
    "a const read in its body",
    "<section><const/a=title/><p>${a}</p></section>",
    "<section>@let a = title;<p>{{ a }}</p></section>",
  ],
  [
    "two consts of different names in one body",
    "<div><const/a=1/><const/b=2/>${a}${b}</div>",
    "<div>@let a = 1;@let b = 2;{{ a }}{{ b }}</div>",
  ],
  [
    "a const in the concise form",
    "div\n  <const/a=2/>\n  -- ${a}",
    "<div>@let a = 2;{{ a }}</div>",
  ],
  [
    "a const in a <for> body that no loop parameter shares a name with",
    "<ul><for|a| of=items><li><const/b=a/>${b}</li></for></ul>",
    "<ul>@for (a of items; track $index) { <li>@let b = a;{{ b }}</li> }</ul>",
  ],
  [
    "a define and its call",
    "<section><define/D>x</define><D/></section>",
    '<section><ng-template #D> x </ng-template><ng-container [ngTemplateOutlet]="D" [ngTemplateOutletContext]="{}"></ng-container></section>',
  ],
  [
    "a const at the top of the template (no element body)",
    "<const/a=1/>${a}",
    "@let a = 1;{{ a }}",
  ],
];

// [label, source, expected template]. The same names #636 wrote.
const RENAMED: Array<[string, string, string]> = [
  [
    "an inner const shadows an outer one",
    "<const/a=1/><div><const/a=2/>${a}</div>${a}",
    "@let a = 1;<div>@let __mxConst_a = 2;{{ __mxConst_a }}</div>{{ a }}",
  ],
  [
    "two sibling bodies declare the same name",
    "<div><const/a=1/>${a}</div><div><const/a=2/>${a}</div>",
    "<div>@let __mxConst_a = 1;{{ __mxConst_a }}</div><div>@let __mxConst_a1 = 2;{{ __mxConst_a1 }}</div>",
  ],
  [
    "two sibling bodies declare the same name and neither reads it",
    "<div><const/a=1/></div><div><const/a=2/></div>",
    "<div>@let __mxConst_a = 1;</div><div>@let __mxConst_a1 = 2;</div>",
  ],
  [
    "a <for> parameter has the name and the const is never read",
    "<ul><for|a| of=items><li><const/a=1/></li></for></ul>",
    "<ul>@for (a of items; track $index) { <li>@let __mxConst_a = 1;</li> }</ul>",
  ],
  [
    "two sibling bodies define the same name and neither calls it",
    "<div><define/D>x</define></div><div><define/D>y</define></div>",
    "<div><ng-template #__mxDefine_D> x </ng-template></div><div><ng-template #__mxDefine_D1> y </ng-template></div>",
  ],
  [
    "a template reference has the name",
    "<main><input #a/><div><const/a=1/>${a}</div></main>",
    "<main><input #a><div>@let __mxConst_a = 1;{{ __mxConst_a }}</div></main>",
  ],
  [
    "a ref- template reference has the name",
    "<main><input ref-a/><div><const/a=1/>${a}</div></main>",
    "<main><input ref-a><div>@let __mxConst_a = 1;{{ __mxConst_a }}</div></main>",
  ],
  [
    "an <ng-template> variable has the name",
    "<main><ng-template let-a><div><const/a=1/>${a}</div></ng-template></main>",
    "<main><ng-template let-a><div>@let __mxConst_a = 1;{{ __mxConst_a }}</div></ng-template></main>",
  ],
  [
    "a structural directive declares the name",
    '<ul><li *ngFor="let a of items"><div><const/a=1/></div></li></ul>',
    '<ul><li *ngFor="let a of items"><div>@let __mxConst_a = 1;</div></li></ul>',
  ],
  [
    "a structural directive declares the name with as",
    '<main><div *ngIf="x as a"><const/a=1/></div></main>',
    '<main><div *ngIf="x as a">@let __mxConst_a = 1;</div></main>',
  ],
  [
    "the name is read after the body, where it means something else",
    "<div><const/x=1/>${x}</div>${x}",
    "<div>@let __mxConst_x = 1;{{ __mxConst_x }}</div>{{ x }}",
  ],
  [
    "the name is read before the body",
    "<p>${x}</p><div><const/x=1/>${x}</div>",
    "<p>{{ x }}</p><div>@let __mxConst_x = 1;{{ __mxConst_x }}</div>",
  ],
  [
    "the same name in the bodies of two <if> branches",
    "<if=x><div><const/a=1/>${a}</div></if><else><div><const/a=2/>${a}</div></else>",
    "@if (x) { <div>@let __mxConst_a = 1;{{ __mxConst_a }}</div> } @else { <div>@let __mxConst_a1 = 2;{{ __mxConst_a1 }}</div> }",
  ],
  [
    "an inner define shadows an outer one",
    "<define/D>x</define><div><define/D>y</define><D/></div><D/>",
    '<ng-template #D> x </ng-template><div><ng-template #__mxDefine_D> y </ng-template><ng-container [ngTemplateOutlet]="__mxDefine_D" [ngTemplateOutletContext]="{}"></ng-container></div><ng-container [ngTemplateOutlet]="D" [ngTemplateOutletContext]="{}"></ng-container>',
  ],
  [
    "an attribute reads the name outside the body",
    "<p class=a></p><div><const/a=1/>${a}</div>",
    "",
  ],
];

describe("a generated name cannot make a self-reading const legal", () => {
  it.each([
    [
      "the name is read in the const's own value",
      "<div><const/x=x+1/>${x}</div>",
    ],
    [
      "a <for> parameter has the name",
      "<ul><for|a| of=items><li><const/a=a/>${a}</li></for></ul>",
    ],
    [
      "a <define> parameter has the name",
      "<define/D|a|><div><const/a=a/>${a}</div></define><D(1)/>",
    ],
  ])("%s", (_label, source) => {
    expect(() => emit(source)).toThrow(/own attributes cannot read it/);
  });
});

describe("an element-body const or define keeps the name the author wrote", () => {
  it.each(AUTHORED)("%s", (_label, source, expected) => {
    expect(emit(source)).toBe(expected);
  });

  it("the unused const, the one a diagnostic quotes, is the authored one", () => {
    expect(emit("<section><const/count=1/></section>")).not.toContain("__mx");
  });
});

describe("a name another declaration or read shares is renamed", () => {
  it.each(RENAMED.filter(([, , expected]) => expected !== ""))(
    "%s",
    (_label, source, expected) => {
      expect(emit(source)).toBe(expected);
    },
  );

  it("an attribute that reads the name outside the body", () => {
    const template = emit("<p class=a></p><div><const/a=1/>${a}</div>");
    expect(template).toContain("@let __mxConst_a = 1;");
    expect(template).not.toContain("@let a ");
  });
});
