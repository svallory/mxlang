import path from "node:path";
import { compileNgMx } from "@mxlang/angular";
import { describe, expect, it } from "vitest";
import { createAngularChecker, diagnoseNgMx } from "./index.ts";
import type { AngularChecker, Diagnostic } from "./types.ts";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const VIRTUAL = path.join(PROJECT_DIR, "x.component.ts");

/** A `.ng.mx` module around one region, as an author would write it. */
function ngMx(template: string, klass = "user = { name: 'a' };"): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    "  standalone: true,",
    `  template: ${template},`,
    "})",
    `export class XComponent { ${klass} }`,
  ].join("\n");
}

/** A checker stub that returns canned records, for the mapping rules alone. */
function stubChecker(records: Diagnostic[]): AngularChecker {
  return {
    check: () => records,
    update: () => {},
    configDiagnostics: () => [],
    dispose: () => {},
  };
}

function record(over: Partial<Diagnostic>): Diagnostic {
  return {
    file: VIRTUAL,
    start: 0,
    length: 1,
    code: 2339,
    message: "m",
    category: "error",
    source: "ngtsc",
    ...over,
  };
}

describe("diagnoseNgMx (real ngtsc)", () => {
  it("reports a bad property at the expression start in the .ng.mx", () => {
    const source = ngMx("<p>${user.nmae}</p>");
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = diagnoseNgMx(compiled, checker, VIRTUAL);
    checker.dispose();

    // The silent-zero guard: a broken template MUST yield a diagnostic, or a
    // broken @angular/core resolution would read as a clean file.
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    const [d] = diagnostics;
    expect(d?.source).toBe("angular");
    expect(d?.code).toBe(2339);
    expect(d?.category).toBe("error");
    expect(d?.message).toMatch(/nmae/);
    expect(d?.start).toBe(source.indexOf("user.nmae"));
    expect(source.slice(d?.start, (d?.start ?? 0) + (d?.length ?? 0))).toBe(
      "user.nmae",
    );
  });

  it("reports nothing for a clean file", () => {
    const compiled = compileNgMx(
      ngMx("<p>${user.name}</p>"),
      "/p/x.component.ng.mx",
    );
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    expect(diagnoseNgMx(compiled, checker, VIRTUAL)).toEqual([]);
    checker.dispose();
  });

  it("drops ts-source records: a class-body error is not reported here", () => {
    // Volar/tsc already report the module's own TypeScript errors; repeating
    // them here would print each one twice.
    const source = ngMx(
      "<p>${user.name}</p>",
      "user = { name: 'a' }; bad: number = 'str';",
    );
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const raw = checker.check(VIRTUAL, compiled.code);
    expect(raw.some((r) => r.source === "ts")).toBe(true);
    expect(diagnoseNgMx(compiled, checker, VIRTUAL)).toEqual([]);
    checker.dispose();
  });
});

describe("diagnoseNgMx (fragment-root region, G9)", () => {
  it("maps a diagnostic in either sibling of a <> fragment back to the .ng.mx", () => {
    // Two roots: a fragment lowers its children as siblings, and both the
    // first and the second must resolve to their own expression.
    const source = ngMx("<><p>${user.nmae}</p><span>${user.nmee}</span></>");
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = diagnoseNgMx(compiled, checker, VIRTUAL);
    checker.dispose();

    expect(diagnostics.map((d) => d.start).sort((a, b) => a - b)).toEqual([
      source.indexOf("user.nmae"),
      source.indexOf("user.nmee"),
    ]);
    for (const d of diagnostics) {
      expect(d.source).toBe("angular");
      expect(source.slice(d.start, d.start + d.length)).toMatch(/^user\.nm/);
    }
  });

  it("reports nothing for a clean fragment-root region", () => {
    const compiled = compileNgMx(
      ngMx("<><p>${user.name}</p><span>${user.name}</span></>"),
      "/p/x.component.ng.mx",
    );
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    expect(diagnoseNgMx(compiled, checker, VIRTUAL)).toEqual([]);
    checker.dispose();
  });

  it("finds the enclosing fragment region for generated punctuation", () => {
    const source = ngMx("<><p>${user.name}</p><span>x</span></>");
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    const region = compiled.regions[0];
    const [d] = diagnoseNgMx(
      compiled,
      stubChecker([record({ start: region?.generatedStart ?? -1 })]),
      VIRTUAL,
    );
    expect(d?.start).toBe(region?.start);
    expect(source.slice(region?.start, region?.end)).toMatch(/^<>/);
  });
});

describe("diagnoseNgMx (mapping rules)", () => {
  const source = ngMx("<p>${user.name}</p>");
  const compiled = compileNgMx(source, "/p/x.component.ng.mx");
  const region = compiled.regions[0];
  const mapping = compiled.mappings.find(
    (m) => source.slice(m.sourceStart, m.sourceEnd) === "user.name",
  );

  it("fixtures are what the tests assume", () => {
    expect(region).toBeDefined();
    expect(mapping).toBeDefined();
  });

  it("drops ts records and keeps ngtsc ones, tagging them angular", () => {
    const start = mapping?.generatedStart ?? -1;
    const out = diagnoseNgMx(
      compiled,
      stubChecker([
        record({ start, source: "ts", message: "ts one" }),
        record({ start, source: "ngtsc", message: "ng one" }),
      ]),
      VIRTUAL,
    );
    expect(out.map((d) => [d.source, d.message])).toEqual([
      ["angular", "ng one"],
    ]);
  });

  it("maps an offset inside an expression to the expression start", () => {
    const inside = (mapping?.generatedStart ?? 0) + 3;
    const [d] = diagnoseNgMx(
      compiled,
      stubChecker([record({ start: inside })]),
      VIRTUAL,
    );
    expect(d?.start).toBe(mapping?.sourceStart);
    expect(d?.length).toBe(
      (mapping?.sourceEnd ?? 0) - (mapping?.sourceStart ?? 0),
    );
  });

  it("falls back to the enclosing region start on generated punctuation", () => {
    // The opening backtick of the template literal belongs to no mapping.
    const [d] = diagnoseNgMx(
      compiled,
      stubChecker([record({ start: region?.generatedStart ?? -1, length: 1 })]),
      VIRTUAL,
    );
    expect(d).toBeDefined();
    expect(d?.start).toBe(region?.start);
  });

  it("never drops a diagnostic outside every region", () => {
    // Offset 0 is the `import` line: no mapping, no region. It is located
    // through the module source map instead of being discarded.
    const out = diagnoseNgMx(
      compiled,
      stubChecker([record({ start: 0, length: 6 })]),
      VIRTUAL,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.start).toBe(0);
    expect(out[0]?.source).toBe("angular");
  });

  it("maps an authored-TypeScript offset after a region through the source map", () => {
    // The class body sits after the region, so its module offset is shifted
    // relative to the .ng.mx; the source map undoes the shift.
    const at = compiled.code.indexOf("user = ");
    const out = diagnoseNgMx(
      compiled,
      stubChecker([record({ start: at, length: 4 })]),
      VIRTUAL,
    );
    expect(out[0]?.start).toBe(source.indexOf("user = "));
  });
});

describe("diagnoseNgMx `mapped` flag (how exact the position is)", () => {
  const source = ngMx("<p>${user.name}</p>");
  const compiled = compileNgMx(source, "/p/x.component.ng.mx");
  const region = compiled.regions[0];
  const expression = compiled.mappings.find(
    (m) => source.slice(m.sourceStart, m.sourceEnd) === "user.name",
  );
  const mappedOf = (start: number, c = compiled) =>
    diagnoseNgMx(c, stubChecker([record({ start })]), VIRTUAL)[0]?.mapped;

  it('is "exact" for an offset inside a mapped expression', () => {
    expect(mappedOf(expression?.generatedStart ?? -1)).toBe("exact");
  });

  it('is "region" when it fell back to the enclosing region start', () => {
    expect(mappedOf(region?.generatedStart ?? -1)).toBe("region");
  });

  it('is "sourcemap" when the module source map located it', () => {
    expect(mappedOf(compiled.code.indexOf("user = "))).toBe("sourcemap");
  });

  it('is "none" when nothing located it and it landed at the file start', () => {
    const noContent = {
      ...compiled,
      map: { ...compiled.map, sourcesContent: undefined },
    } as unknown as typeof compiled;
    expect(mappedOf(0, noContent)).toBe("none");
  });
});

describe("decorator-analysis diagnostics", () => {
  it("reports a misused @Component decorator exactly once, via the semantic phase", () => {
    // getNgStructuralDiagnostics is deliberately not collected: probed on
    // `imports: [123]`, a missing template, and two incompatible decorators,
    // it added nothing the semantic phase had not already reported.
    const source = [
      'import { Component } from "@angular/core";',
      '@Component({ selector: "a", standalone: true, imports: [123], template: "<p></p>" })',
      "export class X {}",
    ].join("\n");
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const records = checker.check(VIRTUAL, source);
    checker.dispose();
    const ngtsc = records.filter((r) => r.source === "ngtsc");
    expect(ngtsc).toHaveLength(1);
    expect(ngtsc[0]?.code).toBe(-991010);
  });
});
