import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { emit } from "./helpers.ts";

describe("strict AOT (ngtsc, strictTemplates) on the emitted bindings", () => {
  const checkerProject = resolve(
    import.meta.dirname,
    "../../../tooling/angular-checker",
  );
  let serial = 0;
  // Local stand-ins for NgFor/NgIf (`@angular/common` is not resolvable from
  // the checker project) with the same context typing.
  const LET_DIRECTIVE = `
@Directive({ selector: "[ngFor][ngForOf]", standalone: true })
export class NgFor<T> {
  @Input() ngForOf!: T[];
  static ngTemplateContextGuard<T>(_d: NgFor<T>, _c: unknown): _c is { $implicit: T } { return true; }
}
@Directive({ selector: "[ngIf]", standalone: true })
export class NgIf<T> {
  @Input() ngIf!: T;
  static ngTemplateContextGuard<T>(_d: NgIf<T>, _c: unknown): _c is { ngIf: NonNullable<T>; $implicit: NonNullable<T> } { return true; }
}
@Directive({ selector: "[mxLet]", standalone: true })
export class MxLet {
  @Input() mxLet?: unknown;
  static ngTemplateContextGuard(_d: MxLet, _c: unknown): _c is { $implicit: { n: string } } { return true; }
  constructor(t: TemplateRef<unknown>, v: ViewContainerRef) { v.createEmbeddedView(t, { $implicit: { n: "x" } }); }
}`;
  function check(template: string, body: string): string[] {
    const checker = createAngularChecker({ projectDir: checkerProject });
    const diagnostics = checker.check(
      join(checkerProject, `primitive-${serial++}.component.ts`),
      `import { Component, Directive, Input, TemplateRef, ViewContainerRef } from "@angular/core";
${LET_DIRECTIVE}
@Component({ selector: "mx-probe", standalone: true, imports: [NgFor, NgIf, MxLet], template: \`${template}\` })
export class Probe {${body}}
`,
    );
    checker.dispose();
    // -998113: the shared header imports every directive, whatever a case uses.
    return diagnostics
      .filter((d) => d.code !== -998113)
      .map((d) => `${d.code} ${d.message.split("\n")[0]}`);
  }

  it("accepts the generic attribute on a div (no NG8002 as with [disabled])", () => {
    const code = emit("<div disabled=flag title=name/>");
    expect(check(code, "flag = true as boolean | null; name = 'n';")).toEqual(
      [],
    );
  });

  it("reports a type error in the authored expression once", () => {
    const code = emit("<div title=missing.nope/>");
    const diagnostics = check(code, "missing = { yes: 1 };");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("nope");
  });

  // A `*` structural attribute is a template around the element: a variable it
  // declares is only in scope inside it, so the `@let` moves inside too.
  const people =
    "people = [{ name: 'a', cls: 'c' }]; u: { n: string } | null = null;";
  it.each([
    ["*ngFor let", '<li *ngFor="let p of people" title=p.name class=p.cls/>'],
    ["*ngIf as", '<div *ngIf="u as who" title=who.n/>'],
    ["a custom let directive", '<div *mxLet="let t" title=t.n/>'],
  ])(
    "%s: the variable is in scope for the attribute expression",
    (_name, source) => {
      const code = emit(source);
      expect(code).toContain("<ng-container *");
      expect(check(code, people)).toEqual([]);
    },
  );

  it("reports a type error in an attribute expression that reads a directive variable once", () => {
    const code = emit('<li *ngFor="let p of people" title=p.nmae/>');
    const diagnostics = check(code, people);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("nmae");
  });
});
