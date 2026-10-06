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
  items = ["a"];
  item = "field";
  sigs = [signal("a")];
  c = true;
`;

interface Found {
  code: number;
  message: string;
  start?: number;
  length?: number;
  /** The `.mx` text the diagnostic's start maps to, through the template mappings. */
  at?: string;
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
  const templateStart = source.indexOf(result.code);
  const found = (diagnostics as unknown as Found[]).map((d) => {
    const offset = (d.start ?? -1) - templateStart;
    const mapping = result.mappings.find(
      (m) => m.generatedStart <= offset && offset < m.generatedEnd,
    );
    return {
      ...d,
      at: mapping
        ? template.slice(mapping.sourceStart, mapping.sourceEnd)
        : undefined,
    };
  });
  return { found, code: source };
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

  it("reports a refinement that is not a member of the component, at the modifier", () => {
    const { found } = check("<div appPick v:nope:=q/>");
    expect(found).toMatchObject([{ code: 2339, at: "nope" }]);
  });

  it("reports a refinement whose parameter does not take the bound value, at the modifier", () => {
    const { found } = check("<div appPick v:bad:=q/>");
    expect(found).toMatchObject([{ code: 2345, at: "bad" }]);
  });

  // Angular's own `[(v)]="item"` on a `@for` variable is "Cannot use a
  // non-signal variable 'item' in a two-way binding expression. Template
  // variables are read-only." A refined form writes a template variable with
  // `.set()`, never `this.item`, so a non-signal one is a type error at the
  // target, whatever the component's own `item` field is.
  it.each([
    [
      "a @for item",
      "<for|item| of=items><div appPick v:fn:=item/></for>",
      "item",
    ],
    ["a @let from <const>", "<const/x=q/><div appPick v:fn:=x/>", "x"],
  ])(
    "reports a non-signal template variable target (%s) at the target",
    (_name, mx, at) => {
      const { found, code } = check(mx);
      expect(code).not.toContain("__mxSet(this");
      // `.set` on the variable; the index also mistypes `[v]` (a number into
      // a string input), which is the fixture's, not the refinement's.
      expect(found).toContainEqual(expect.objectContaining({ code: 2339, at }));
    },
  );

  it("rejects a @for index before ngtsc runs, as [(v)] does", () => {
    expect(() =>
      check("<for|item, i| of=items><div appPick v:fn:=i/></for>"),
    ).toThrow(/cannot write `i`.*never a signal/);
  });

  it("accepts a template variable that holds a signal, as [(v)] does", () => {
    expect(check("<for|s| of=sigs><div appPick v:fn:=s/></for>").found).toEqual(
      [],
    );
  });

  it("writes a member of a template variable through the object", () => {
    const { found, code } = check(
      "<for|o| of=items><div appPick v:fn:=box.v/></for>",
    );
    expect(found).toEqual([]);
    expect(code).toContain("__mxSet(box, 'v', fn($event))");
  });
});
