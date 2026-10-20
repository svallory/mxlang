// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template source
/**
 * Angular's own diagnostics quote a `@let` by name (NG8112, the two-way
 * binding error). The emitter gives a `<const>` in an element body, a tag call
 * body or an attribute tag body a generated name only when its name collides
 * with another declaration or read; either way the diagnostic an author reads
 * names the `<const>` as written.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  });
});

describe("a <const> in an MX tag call body", () => {
  // A real project under this package, so compiler-cli and core resolve as they
  // do for an Angular app. The tag is imported by the `.ng.mx` file, so it is a
  // component the emitter calls by selector.
  function inProject<T>(run: (dir: string) => T): T {
    const dir = realpathSync(
      mkdtempSync(path.join(import.meta.dirname, "tag-call-body-")),
    );
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ mx: { host: "angular" } }),
      );
      mkdirSync(path.join(dir, "tags"));
      writeFileSync(
        path.join(dir, "tags", "card.mx"),
        "<section>${input.content()}</section>\n",
      );
      return run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function inCard(dir: string, template: string, code: number) {
    const source = [
      'import { Component } from "@angular/core";',
      'import Card from "./tags/card.mx";',
      "",
      "@Component({",
      '  selector: "app-x",',
      "  standalone: true,",
      `  template: ${template},`,
      "})",
      "export class XComponent { title = 'a'; }",
    ].join("\n");
    const compiled = compileNgMx(source, path.join(dir, "x.component.ng.mx"));
    const checker = createAngularChecker({ projectDir: dir });
    try {
      const found = diagnoseNgMx(
        compiled,
        checker,
        path.join(dir, "x.component.ts"),
      );
      return {
        code: compiled.code,
        messages: found.filter((d) => d.code === code).map((d) => d.message),
      };
    } finally {
      checker.dispose();
    }
  }

  it("NG8112 on a renamed const names it as written", () => {
    inProject((dir) => {
      const { code, messages } = inCard(
        dir,
        "<main><const/a=1/>${a}<Card><const/a=2/></Card></main>",
        UNUSED_LET,
      );
      expect(code).toMatch(/@let __mxConst_a\d* = 2;/);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(
        "@let a is declared but its value is never read",
      );
      expect(messages[0]).not.toContain("__mx");
    });
  }, 60_000);

  it("NG8112 on a renamed const in an attribute tag body names it as written", () => {
    inProject((dir) => {
      const { code, messages } = inCard(
        dir,
        "<main><const/a=1/>${a}<Card><@header><const/a=2/></@header></Card></main>",
        UNUSED_LET,
      );
      expect(code).toMatch(/@let __mxConst_a\d* = 2;/);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("@let a is declared");
      expect(messages[0]).not.toContain("__mx");
    });
  }, 60_000);

  it("a const nobody else uses keeps its name, and NG8112 quotes it", () => {
    inProject((dir) => {
      const { code, messages } = inCard(
        dir,
        "<main><Card><const/a=2/></Card></main>",
        UNUSED_LET,
      );
      expect(code).toContain("@let a = 2;");
      expect(code).not.toContain("__mx");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("@let a is declared");
    });
  }, 60_000);

  it("two sibling tag calls declaring the same name raise no duplicate-declaration error", () => {
    inProject((dir) => {
      const { code, messages } = inCard(
        dir,
        "<main><Card><const/a=2/>${a}</Card><Card><const/a=3/>${a}</Card></main>",
        DUPLICATE_LET,
      );
      expect(code).toContain("@let __mxConst_a1 = 3;");
      expect(messages).toEqual([]);
    });
  }, 60_000);
});

describe("a diagnostic about a <const> destructuring pattern names what the author wrote", () => {
  it("NG8112 on an unused name of an object pattern", () => {
    const found = messages(
      "<section><const/{ a, b }={ a: 1, b: 2 }/>${a}</section>",
      UNUSED_LET,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(
      "@let b is declared but its value is never read",
    );
    expect(found[0]).not.toContain("__mx");
  });

  it("NG8112 on an unused name of an array pattern with a default", () => {
    const found = messages(
      "<section><const/[a, b = 3]=[1]/>${a}</section>",
      UNUSED_LET,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("@let b is declared");
    expect(found[0]).not.toContain("__mx");
  });

  it("NG8112 on a renamed name of a pattern names it as written", () => {
    const compiled = compileNgMx(
      ngMx(
        "<main><const/{ a }={ a: 1 }/>${a}<div><const/{ a }={ a: 2 }/></div></main>",
      ),
      "/p/x.component.ng.mx",
    );
    expect(compiled.regions[0]?.authoredNames).toMatchObject({
      __mxConst_a: "a",
      __mxPattern1: "{ a }",
    });
    const found = messages(
      "<main><const/{ a }={ a: 1 }/>${a}<div><const/{ a }={ a: 2 }/></div></main>",
      UNUSED_LET,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("@let a is declared");
    expect(found[0]).not.toContain("__mx");
  });

  it("NG8112 on an empty pattern prints the pattern, not the generated holder", () => {
    const found = messages(
      "<section><const/{}={ a: 1 }/></section>",
      UNUSED_LET,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("@let {} is declared");
    expect(found[0]).not.toContain("__mx");
  });

  it("two sibling bodies binding the same pattern name raise no duplicate-declaration error", () => {
    expect(
      messages(
        "<main><div><const/{ a }={ a: 1 }/>${a}</div><div><const/{ a }={ a: 2 }/>${a}</div></main>",
        DUPLICATE_LET,
      ),
    ).toEqual([]);
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
