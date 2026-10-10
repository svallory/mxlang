// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX template source
import path from "node:path";
import { compileNgMx } from "@mxlang/host-angular";
import { describe, expect, it } from "vitest";
import {
  createAngularChecker,
  diagnoseNgMx,
  mapNgMxDiagnostics,
} from "./index.ts";
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
  it.each(["ngFor", "ngIf"])(
    "locates NG8103 at the %s name, after its structural *",
    (name) => {
      const attribute =
        name === "ngFor" ? '*ngFor="let i of items"' : '*ngIf="items"';
      const source = ngMx(
        `<ul><li ${attribute}>x</li></ul>`,
        "items = [1, 2];",
      );
      const compiled = compileNgMx(source, "/p/x.component.ng.mx");
      const checker = createAngularChecker({ projectDir: PROJECT_DIR });
      try {
        const diagnostic = diagnoseNgMx(compiled, checker, VIRTUAL).find(
          (d) => d.code === -998103,
        );
        expect(diagnostic).toBeDefined();
        expect(diagnostic?.start).toBe(source.indexOf(name));
        expect(diagnostic?.length).toBe(name.length);
        expect(diagnostic?.mapped).toBe("exact");
      } finally {
        checker.dispose();
      }
    },
  );
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

describe("diagnoseNgMx element and attribute diagnostics (real ngtsc)", () => {
  /** Check `template` against real ngtsc and return the `.ng.mx` source and results. */
  function check(template: string) {
    const source = ngMx(template, "title = 'hi';");
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = diagnoseNgMx(compiled, checker, VIRTUAL);
    checker.dispose();
    return { source, diagnostics };
  }

  /** The source text a diagnostic flags. */
  const flagged = (
    source: string,
    d: { start: number; length: number } | undefined,
  ) => source.slice(d?.start, (d?.start ?? 0) + (d?.length ?? 0));

  it("NG8001 on an unknown element points at its authored name", () => {
    const { source, diagnostics } = check("<div><app-chld></app-chld></div>");
    const d = diagnostics.find((x) => x.code === -998001);
    expect(d?.mapped).toBe("node");
    expect(d?.start).toBe(source.indexOf("app-chld"));
    expect(flagged(source, d)).toBe("app-chld");
  });

  it("NG8002 on a dynamic attribute points at the authored attribute", () => {
    const { source, diagnostics } = check("<div><input lable=title/></div>");
    const d = diagnostics.find((x) => x.code === -998002);
    expect(d?.mapped).toBe("node");
    expect(d?.start).toBe(source.indexOf("lable"));
    expect(flagged(source, d)).toBe("lable=title");
  });

  it("NG8002 on a bracket-named attribute starts at its `[`, not the emitted wrapper", () => {
    const { source, diagnostics } = check("<div><input [value]=title/></div>");
    const d = diagnostics.find((x) => x.code === -998002);
    expect(d?.mapped).toBe("node");
    expect(d?.start).toBe(source.indexOf("[value]"));
    expect(flagged(source, d)).toBe("[value]=title");
  });

  it("a default attribute has no spelled name, so it lands on its value", () => {
    const { source, diagnostics } = check(
      '<div><my-widget=title><case="a">a</case></my-widget></div>',
    );
    const starts = diagnostics.map((d) => d.start);
    // `<my-widget>` and `<case>` (NG8001) point at their names; the `value`
    // input Angular finds on `<my-widget>` (NG8002) at the default value. A
    // dashed tag keeps input bindings; an undashed one is a native element,
    // where `value` (a DOM property of other elements) is `[attr.value]`.
    // <switch=…> is now an MX error, tested in fix-hints.test.ts.
    expect(starts).toContain(source.indexOf("my-widget"));
    expect(starts).toContain(source.indexOf("case"));
    const bound = diagnostics.find((x) => x.code === -998002);
    expect(bound?.start).toBe(source.indexOf("title"));
    expect(bound?.mapped).toBe("node");
  });

  it("an attribute whose value needs template-literal escaping still resolves", () => {
    // The backtick and `${` are escaped in the emitted literal, shifting every
    // offset after them; the anchor must still land on the attribute.
    const { source, diagnostics } = check(
      "<div><input lable=`a${title}`/><p>${title.nmae}</p></div>",
    );
    const attr = diagnostics.find((x) => x.code === -998002);
    expect(attr?.mapped).toBe("node");
    expect(attr?.start).toBe(source.indexOf("lable"));
    // And an expression after it is still exact.
    const expr = diagnostics.find((x) => x.code === 2339);
    expect(expr?.mapped).toBe("exact");
    expect(expr?.start).toBe(source.indexOf("title.nmae"));
  });

  it("an offset in generated punctuation with no anchor keeps the region fallback, never a guessed position", () => {
    const source = ngMx("<div><p>x</p></div>");
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    // The `</p>` closer is emitted punctuation: no mapping, no anchor.
    const at = compiled.code.indexOf("</p>");
    const [d] = diagnoseNgMx(
      compiled,
      stubChecker([record({ start: at, length: 4 })]),
      VIRTUAL,
    );
    expect(d?.mapped).toBe("region");
    expect(d?.start).toBe(compiled.regions[0]?.start);
  });

  it("an unanchored node (a synthesized element) keeps the region fallback", () => {
    const source = ngMx("<p>x</p>");
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    // Strip the anchors, as for a node the IR gave no span: the same offset
    // must degrade rather than land on a neighbour.
    const bare = { ...compiled, anchors: [] };
    const at = compiled.code.indexOf("<p>");
    const [d] = diagnoseNgMx(
      bare,
      stubChecker([record({ start: at, length: 3 })]),
      VIRTUAL,
    );
    expect(d?.mapped).toBe("region");
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

describe("mapNgMxDiagnostics (records from a worker)", () => {
  it("maps ngtsc records and drops ts ones, like diagnoseNgMx", () => {
    const source = ngMx("<p>${user.nmae}</p>");
    const compiled = compileNgMx(source, "/p/x.component.ng.mx");
    const start = compiled.code.indexOf("user.nmae");
    const out = mapNgMxDiagnostics(compiled, [
      record({ start, source: "ngtsc" }),
      record({ start, source: "ts" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "angular", mapped: "exact" });
  });
});
