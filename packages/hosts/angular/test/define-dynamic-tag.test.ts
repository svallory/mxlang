// @vitest-environment jsdom
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX `${…}` placeholders in template source
/**
 * `<${D}/>` where `D` is a `<define>` renders the define (stock Marko 6.4.4:
 * `<define/D><i>b</i></define><${D}/>` renders `<i>b</i>`). A define here is an
 * `<ng-template #D>`, a `TemplateRef`, which `ngComponentOutlet` cannot render,
 * so the target used to be bound to a component outlet and failed at run time.
 * A bare define now renders through `ngTemplateOutlet`; a conditional target
 * becomes `@if`/`@else`, each branch lowered by what it names, so no value is
 * tested at run time.
 *
 * Probed on stock with `bun run --cwd packages/stock-marko probe`: the plain,
 * body and conditional sources compile there; the define declared after the
 * read is a compile error ("Hoisted values must be functions. The `<define>`
 * tag variable may not be hoisted").
 */
import "@angular/compiler";
import { join, resolve } from "node:path";
import { NgComponentOutlet, NgTemplateOutlet } from "@angular/common";
import { Component } from "@angular/core";
import { getTestBed, TestBed } from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { assertAngularParses, emit } from "./helpers.ts";

beforeAll(() => {
  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  );
});

afterEach(() => TestBed.resetTestingModule());

let counter = 0;

@Component({ selector: "mx-other", template: "<u>o</u>" })
class Other {}

/** Renders an emitted template in a component whose `input` is `{ c }`. */
function render(source: string, c = true, pick: unknown = Other): string {
  const template = emit(source);
  assertAngularParses(template);
  class Probe {
    input = { c, other: Other, pick };
  }
  counter += 1;
  Component({
    selector: `mx-define-dyn-${counter}`,
    imports: [NgTemplateOutlet, NgComponentOutlet],
    template,
  })(Probe);
  const fixture = TestBed.createComponent(Probe);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).innerHTML
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/ ng-reflect-[\w-]+="[^"]*"/g, "")
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

const DEFINE = "<define/D><i>b</i></define>";

describe("angular: a dynamic tag reads a <define>", () => {
  it("renders the define through ngTemplateOutlet", () => {
    const template = emit(`${DEFINE}<\${D}/>`);
    expect(template).toContain(
      '<ng-container [ngTemplateOutlet]="D" [ngTemplateOutletContext]="{}"></ng-container>',
    );
    expect(template).not.toContain("ngComponentOutlet");
    expect(render(`${DEFINE}<\${D}/>`)).toBe("<i>b</i>");
  });

  it("a conditional target lowers each branch by what it names", () => {
    const source = `${DEFINE}<\${input.c ? D : input.other}/>`;
    const template = emit(source);
    expect(template).toContain(
      '@if (input.c) { <ng-container [ngTemplateOutlet]="D" [ngTemplateOutletContext]="{}"></ng-container> } @else { <ng-container [ngComponentOutlet]="input.other"></ng-container> }',
    );
    expect(render(source, true)).toBe("<i>b</i>");
    expect(render(source, false)).toBe("<mx-other><u>o</u></mx-other>");
  });

  it("a nested conditional lowers every level", () => {
    const source = `${DEFINE}<\${input.c ? input.other : input.c ? D : D}/>`;
    const template = emit(source);
    expect(template).toContain(
      "@if (input.c) { <ng-container [ngComponentOutlet]",
    );
    expect(template).toContain("@else { @if (input.c) {");
    expect(render(source, false)).toBe("<i>b</i>");
  });

  it("a define in an element body reads from inside it", () => {
    expect(render("<div><define/D><i>b</i></define><${D}/></div>")).toBe(
      "<div><i>b</i></div>",
    );
  });

  it("a loop param named like the define shadows it", () => {
    const template = emit(`${DEFINE}<for|D| of=[input.other]><\${D}/></for>`);
    expect(template).toContain('[ngComponentOutlet]="D"');
    expect(template).not.toContain("ngTemplateOutlet]");
  });

  it("a target that does not read a define is unchanged", () => {
    expect(emit("<${input.other}/>")).toBe(
      '<ng-container [ngComponentOutlet]="input.other"></ng-container>',
    );
  });

  it("with a body is refused, as a define call with a body is", () => {
    const error = thrown(`${DEFINE}<\${D}>x</>`);
    expect(error?.message).toContain(
      "`<${…}>` with content isn't supported by @mxlang/host-angular",
    );
  });

  it("a define read any other way in the target is refused, naming the fix", () => {
    for (const target of ["String(D)", "[D][0]", "input.f(() => D)"]) {
      const error = thrown(`${DEFINE}<\${${target}}/>`);
      expect(error?.message, target).toContain(
        "a `<define>` read inside this dynamic tag's expression can't be rendered by @mxlang/host-angular",
      );
      expect(error?.message, target).toContain(
        "Write the choice as `<if=c><D/></if><else>…</else>`",
      );
      expect(error?.line, target).toBe(1);
    }
  });

  it("a define with a param is refused: the context needs an argument", () => {
    const error = thrown("<define/D|v|><b>${v}</b></define><${D}/>");
    expect(error?.message).toContain("which takes 1 argument(s)");
    expect(error?.message).toContain("call it as `<D(...)/>`");
  });

  it("attributes on a define target are dropped, as on `<D n=3/>`; the other branch keeps them", () => {
    expect(emit(`${DEFINE}<D n=3/>`)).toContain(
      '[ngTemplateOutletContext]="{}"',
    );
    const plain = emit(`${DEFINE}<\${D} n=3/>`);
    expect(plain).toContain('[ngTemplateOutlet]="D"');
    expect(plain).not.toContain("n:");
    const mixed = emit(`${DEFINE}<\${input.c ? D : input.other} class="x"/>`);
    expect(mixed).toContain(
      '@else { <ng-container [ngComponentOutlet]="input.other" [ngComponentOutletInputs]="{ class: &quot;x&quot; }"></ng-container> }',
    );
    expect(mixed).toMatch(
      /@if \(input\.c\) \{ <ng-container \[ngTemplateOutlet\]="D" \[ngTemplateOutletContext\]="\{\}"><\/ng-container> \}/,
    );
    expect(render(`${DEFINE}<\${D} n=3/>`)).toBe("<i>b</i>");
  });

  it("`||`, `&&` and `??` choose between their operands as a conditional does", () => {
    const or = `${DEFINE}<\${input.pick || D}/>`;
    expect(emit(or)).toContain(
      '@if (input.pick) { <ng-container [ngComponentOutlet]="input.pick"></ng-container> } @else { <ng-container [ngTemplateOutlet]="D"',
    );
    expect(render(or, true, null)).toBe("<i>b</i>");
    expect(render(or, true, Other)).toBe("<mx-other><u>o</u></mx-other>");

    const and = `${DEFINE}<\${input.pick && D}/>`;
    expect(emit(and)).toContain(
      '@if (input.pick) { <ng-container [ngTemplateOutlet]="D"',
    );
    expect(render(and, true, Other)).toBe("<i>b</i>");
    expect(render(and, true, null)).toBe("");

    const nullish = `${DEFINE}<\${input.pick ?? D}/>`;
    expect(emit(nullish)).toContain("@if ((input.pick) != null) {");
    expect(render(nullish, true, null)).toBe("<i>b</i>");
    expect(render(nullish, true, Other)).toBe("<mx-other><u>o</u></mx-other>");
  });

  it("a name bound inside the expression shadows the define", () => {
    for (const target of ["input.f((D) => D)", "input.f(({ D }) => D)"]) {
      expect(emit(`${DEFINE}<\${${target}}/>`), target).toBe(
        `<ng-template #D> <i>b</i> </ng-template><ng-container [ngComponentOutlet]="${target
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")}"></ng-container>`,
      );
    }
  });

  it("a define declared after the read is refused by core", () => {
    expect(thrown(`<\${D}/>${DEFINE}`)).toMatchObject({
      diagnosticCode: "MX_DEFINE_READ_BEFORE_DECLARATION",
      line: 1,
      column: 3,
    });
  });
});

describe("angular: the lowered target passes the strict template check", () => {
  const checkerProject = resolve(
    import.meta.dirname,
    "../../../tooling/angular-checker",
  );
  // Local stand-ins: `@angular/common` is not resolvable from the checker
  // project. They carry the real inputs' types as of writing; a type change
  // in `@angular/common` will not show up here, only in the TestBed renders
  // above and the angular oracle.
  const OUTLETS = `
@Directive({ selector: "[ngTemplateOutlet]", standalone: true })
export class NgTemplateOutlet {
  @Input() ngTemplateOutlet!: TemplateRef<any> | null;
  @Input() ngTemplateOutletContext?: object | null;
}
@Directive({ selector: "[ngComponentOutlet]", standalone: true })
export class NgComponentOutlet {
  @Input() ngComponentOutlet!: Type<any> | null;
}`;
  let serial = 0;
  function check(template: string, body = ""): string[] {
    const checker = createAngularChecker({ projectDir: checkerProject });
    const diagnostics = checker.check(
      join(checkerProject, `define-dyn-${serial++}.component.ts`),
      `import { Component, Directive, Input, TemplateRef, Type } from "@angular/core";
${OUTLETS}
@Component({ selector: "mx-probe", standalone: true, imports: [NgTemplateOutlet, NgComponentOutlet], template: \`${template}\` })
export class Probe {${body}}
`,
    );
    checker.dispose();
    return diagnostics
      .filter((d) => d.code !== -998113)
      .map((d) => `${d.code} ${d.message.split("\n")[0]}`);
  }

  it("a bare define target type-checks", () => {
    expect(check(emit(`${DEFINE}<\${D}/>`))).toEqual([]);
  });

  it("a conditional target type-checks", () => {
    expect(
      check(
        emit(`${DEFINE}<\${input.c ? D : input.other}/>`),
        "input = { c: true, other: class Other {} };",
      ),
    ).toEqual([]);
  });

  it("a logical target type-checks", () => {
    expect(
      check(
        emit(`${DEFINE}<\${input.pick || D}/>`),
        "input = { pick: null as (new () => object) | null };",
      ),
    ).toEqual([]);
  });

  it("the template reference is not a component type: the old binding failed", () => {
    const diagnostics = check(
      '<ng-template #D><i>b</i></ng-template><ng-container [ngComponentOutlet]="D"></ng-container>',
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
