// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template source
/**
 * Angular's own diagnostics quote a `@let` by name (NG8112, the two-way
 * binding error). The emitter gives a `<const>` in an element body a generated
 * name only when its name collides with another declaration or read; either
 * way the diagnostic an author reads names the `<const>` as written.
 */
import path from "node:path";
import { compileNgMx } from "@mxlang/host-angular";
import { describe, expect, it } from "vitest";
import {
  createAngularChecker,
  diagnoseNgMx,
  mapNgMxDiagnostics,
} from "./index.ts";
import type { Diagnostic } from "./types.ts";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const VIRTUAL = path.join(PROJECT_DIR, "x.component.ts");

function ngMx(template: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    "  standalone: true,",
    `  template: ${template},`,
    "})",
    "export class XComponent { title = 'a'; }",
  ].join("\n");
}

function messages(template: string, code: number): string[] {
  const compiled = compileNgMx(ngMx(template), "/p/x.component.ng.mx");
  const checker = createAngularChecker({ projectDir: PROJECT_DIR });
  try {
    return diagnoseNgMx(compiled, checker, VIRTUAL)
      .filter((d) => d.code === code)
      .map((d) => d.message);
  } finally {
    checker.dispose();
  }
}

const UNUSED_LET = -998112;
const DUPLICATE_LET = -998017;
const TWO_WAY_LET = -99998005;

describe("an Angular diagnostic about a <const> names it as written", () => {
  describe("when nothing else shares the name (the emitter keeps it)", () => {
    it("NG8112 on an unused const in a single root", () => {
      const found = messages("<section><const/a=1/></section>", UNUSED_LET);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain(
        "@let a is declared but its value is never read",
      );
      expect(found[0]).not.toContain("__mx");
    });

    it("the two-way binding error", () => {
      const found = messages(
        "<section><const/a=title/><input value:=a/></section>",
        TWO_WAY_LET,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("non-signal @let declaration 'a'");
      expect(found[0]).not.toContain("__mx");
    });
  });

  describe("when an Angular template reference or variable has the name", () => {
    it.each([
      ["a #ref", "<main><input #a/><div><const/a=1/>${a}</div></main>"],
      [
        "a ref- reference",
        "<main><input ref-a/><div><const/a=1/>${a}</div></main>",
      ],
      [
        "an <ng-template> variable",
        "<main><ng-template let-a><div><const/a=1/>${a}</div></ng-template></main>",
      ],
    ])("%s: no NG8017, the @let is renamed", (_label, source) => {
      expect(messages(source, DUPLICATE_LET)).toEqual([]);
      expect(compileNgMx(ngMx(source), "/p/x.component.ng.mx").code).toContain(
        "@let __mxConst_a = 1;",
      );
    });
  });

  describe("when the name collides (the emitter renames it)", () => {
    it("NG8112 on two sibling bodies that declare the same name", () => {
      const source =
        "<main><div><const/a=1/></div><div><const/a=2/></div></main>";
      expect(compileNgMx(ngMx(source), "/p/x.component.ng.mx").code).toContain(
        "__mxConst_a1",
      );
      const found = messages(source, UNUSED_LET);
      expect(found).toHaveLength(2);
      for (const message of found) {
        expect(message).toContain(
          "@let a is declared but its value is never read",
        );
        expect(message).not.toContain("__mx");
      }
    });

    it("NG8112 on a const whose name is read outside its body", () => {
      const found = messages(
        "<main><div><const/a=1/></div><p>${a}</p></main>",
        UNUSED_LET,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("@let a is declared");
      expect(found[0]).not.toContain("__mx");
    });

    it("the two-way binding error on a shadowing const", () => {
      const source =
        "<main><const/a=title/><div><const/a=title/><input value:=a/></div></main>";
      expect(compileNgMx(ngMx(source), "/p/x.component.ng.mx").code).toContain(
        '[(value)]="__mxConst_a1"',
      );
      const found = messages(source, TWO_WAY_LET);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("non-signal @let declaration 'a'");
      expect(found[0]).not.toContain("__mx");
    });
  });
});

describe("mapNgMxDiagnostics prints the authored name", () => {
  const source = ngMx(
    "<main><div><const/a=1/></div><div><const/a=2/></div><div><const/a1=3/></div><p>${a1}</p></main>",
  );

  function record(start: number, message: string): Diagnostic {
    return {
      file: VIRTUAL,
      start,
      length: 1,
      code: 8112,
      message,
      category: "warning",
      source: "ngtsc",
    };
  }

  it("maps every generated name in a message, and only whole names", () => {
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    const region = compiled.regions[0];
    expect(region?.authoredNames).toEqual({
      __mxConst_a: "a",
      __mxConst_a1: "a",
      __mxConst_a11: "a1",
    });
    const [mapped] = mapNgMxDiagnostics(compiled, [
      record(
        (region?.generatedStart ?? 0) + 1,
        "@let __mxConst_a1 shadows __mxConst_a and __mxConst_a11; __mxConst_a1x stays",
      ),
    ]);
    expect(mapped?.message).toBe(
      "@let a shadows a and a1; __mxConst_a1x stays",
    );
  });

  it("leaves a message outside every region as Angular wrote it", () => {
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    const [mapped] = mapNgMxDiagnostics(compiled, [
      record(0, "@let __mxConst_a is declared"),
    ]);
    expect(mapped?.message).toBe("@let __mxConst_a is declared");
  });

  it("maps a <define> reference name", () => {
    const withDefine = ngMx(
      "<main><define/D>x</define><div><define/D>y</define></div></main>",
    );
    const compiled = compileNgMx(withDefine, "/p/x.component.ng.mx");
    const region = compiled.regions[0];
    expect(region?.authoredNames).toEqual({
      __mxDefine_D: "D",
      __mxDefine_D1: "D",
    });
    const [mapped] = mapNgMxDiagnostics(compiled, [
      record(
        (region?.generatedStart ?? 0) + 1,
        "Reference #__mxDefine_D1 is unused",
      ),
    ]);
    expect(mapped?.message).toBe("Reference #D is unused");
  });
});
