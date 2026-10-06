import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "../../../tooling/angular-checker/src/index.ts";
import { REFINE_HELPER_MEMBERS } from "../src/emitter.ts";
import { compile } from "../src/index.ts";

// ngtsc + strictTemplates over the template a refined bound attribute emits:
// the `__mxSet` write is typed for a plain property and for a WritableSignal,
// and a misspelled or ill-typed refinement is reported at the modifier.
const checkerProject = resolve(
  import.meta.dirname,
  "../../../tooling/angular-checker",
);

const CLASS_BODY = `
${REFINE_HELPER_MEMBERS.join("\n")}
  q = "a";
  sig = signal("a");
  box = { v: "a", sig: signal("a") };
  fn(next: string): string { return next.toUpperCase(); }
  bad(next: number): string { return String(next); }
`;

interface Found {
  code: number;
  message: string;
  start?: number;
  length?: number;
}

function check(template: string): { found: Found[]; code: string } {
  const result = compile(template, "x.mx");
  const source = `import { Component, Directive, EventEmitter, Input, Output, signal } from "@angular/core";
@Directive({ selector: "[appPick]", standalone: true })
export class Pick { @Input() v = ""; @Output() vChange = new EventEmitter<string>(); }
@Component({ selector: "mx-probe", standalone: true, imports: [Pick], template: \`${result.code}\` })
export class Probe {${CLASS_BODY}}
`;
  const checker = createAngularChecker({ projectDir: checkerProject });
  const diagnostics = checker.check(
    join(checkerProject, "bound-refinement.component.ts"),
    source,
  );
  checker.dispose();
  return { found: diagnostics as unknown as Found[], code: source };
}

describe("a refined bound attribute type-checks under strictTemplates", () => {
  it.each([
    ["a plain property", "<div appPick v:fn:=q/>"],
    ["a WritableSignal", "<div appPick v:fn:=sig/>"],
    ["a member of an object", "<div appPick v:fn:=box.v/>"],
    ["a signal member of an object", "<div appPick v:fn:=box.sig/>"],
  ])("accepts %s as the target", (_name, mx) => {
    expect(check(mx).found).toEqual([]);
  });

  it("reports a refinement that is not a member of the component", () => {
    const { found } = check("<div appPick v:nope:=q/>");
    expect(found.map((d) => d.code)).toContain(2339);
  });

  it("reports a refinement whose parameter does not take the bound value", () => {
    const { found } = check("<div appPick v:bad:=q/>");
    expect(found.map((d) => d.code)).toContain(2345);
  });
});
