import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplate } from "@angular/compiler";
import { getCustomTags, positionRegionSource } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import {
  compileNgMx,
  escapeTemplateLiteral,
  NG_MX_FRAGMENT_POSITION_MESSAGE,
  NG_MX_POSITION_MESSAGE,
  ngMxPositionCheck,
  rebaseRegionMappings,
} from "../src/ng-mx.ts";
import { angularOwnTargets } from "../src/own-targets.ts";
import { assertModuleTypechecks } from "./helpers.ts";

/** A `.ng.mx` module around one region, as an author would write it. */
function componentFile(template: string, extra = ""): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-x",',
    `  template: ${template},`,
    "})",
    `export class XComponent {${extra}}`,
  ].join("\n");
}

/** The backtick template literal the emitted module assigns to `template:`. */
function emittedTemplate(code: string): string {
  const match = code.match(/template: `([\s\S]*?)`,\n/);
  if (!match) throw new Error(`no template literal in:\n${code}`);
  return match[1] as string;
}

/** The error a compile threw, as an object with a readable `loc`. */
function thrown(run: () => unknown): SyntaxError & {
  loc?: { line: number; column: number };
} {
  try {
    run();
  } catch (error) {
    return error as SyntaxError & { loc?: { line: number; column: number } };
  }
  throw new Error("expected a compile error");
}

describe("compileNgMx", () => {
  it("lowers a region to a backtick template literal in place", () => {
    const result = compileNgMx(
      componentFile('<div class="list">hi ${name}</div>'),
      "/p/x.component.ng.mx",
    );

    expect(emittedTemplate(result.code)).toBe(
      '<div class="list">hi {{ name }}</div>',
    );
    // The surrounding TypeScript is untouched — it is the author's module,
    // not something MX generates.
    expect(result.code).toContain('import { Component } from "@angular/core";');
    expect(result.code).toContain("export class XComponent");
    expect(result.code).toContain('selector: "app-x"');
  });

  it("emits a template the real Angular compiler parses", () => {
    const result = compileNgMx(
      componentFile(
        "<ul><for|p| of=people by=(p => p.id)><li>${p.name}</li></for></ul>",
      ),
      "/p/x.component.ng.mx",
    );

    const parsed = parseTemplate(
      emittedTemplate(result.code),
      "x.component.ng.mx",
    );
    expect(parsed.errors).toBe(null);
  });

  describe("template-literal escaping (decision 99)", () => {
    it("escapes a backtick in template text", () => {
      const result = compileNgMx(
        componentFile("<p>a ` b</p>"),
        "/p/x.component.ng.mx",
      );
      // Escaped in the emitted source…
      expect(result.code).toContain("\\`");
      // …and still a plain backtick once JavaScript unescapes it.
      expect(emittedTemplate(result.code)).toContain("\\`");
    });

    it("escapes `${` in template text, so it is not a live substitution", () => {
      // The exact hazard A4 divergence 3 named when it rejected backticks.
      // `$!{...}` would be a raw-HTML placeholder, and a bare `$` followed by
      // `{` is ordinary MX text, so this reaches the emitter as literal text.
      const result = compileNgMx(
        componentFile("<p>cost: $ {amount}</p>"),
        "/p/x.component.ng.mx",
      );
      const template = emittedTemplate(result.code);
      // Angular's own brace escaping applies first; what matters here is that
      // no unescaped `${` survives into the literal, which would make the
      // emitted module interpolate at runtime.
      expect(template).not.toMatch(/(?<!\\)\$\{/);
    });

    it("escapes a backslash before anything else", () => {
      // `\` must be escaped first or it would double the backslashes the
      // other two substitutions introduce.
      expect(escapeTemplateLiteral("a \\ b")).toBe("a \\\\ b");
      expect(escapeTemplateLiteral("`")).toBe("\\`");
      expect(escapeTemplateLiteral("${x}")).toBe("\\${x}");
      expect(escapeTemplateLiteral("\\`")).toBe("\\\\\\`");
    });
  });

  describe("region position (C3)", () => {
    const at = (
      propertyKey: string | null,
      decoratorNames: string[],
      isDirectPropertyValue: boolean,
      argumentIndex: number | null,
    ) =>
      ngMxPositionCheck({
        propertyKey,
        decoratorNames,
        enclosingDecoratorNames: [],
        isDirectPropertyValue,
        argumentIndex,
      });

    it("accepts the one legal position", () => {
      expect(at("template", ["Component"], true, 0)).toEqual({ ok: true });
    });

    it("rejects a property that is not `template`", () => {
      expect(at("styles", ["Component"], true, 0)).toEqual({
        ok: false,
        message: NG_MX_POSITION_MESSAGE,
      });
    });

    it("rejects a non-Component decorator", () => {
      expect(at("template", ["Directive"], true, 0).ok).toBe(false);
    });

    it("rejects a wrapped (non-direct) value", () => {
      // `@Component(wrap({ template: <div/> }))`, a ternary, an array…
      expect(at("template", ["Component"], false, 0).ok).toBe(false);
    });

    it("rejects a region outside argument 0", () => {
      // `@Component(opts, { template: <div/> })` — the distinction no other
      // field of the context can make.
      expect(at("template", ["Component"], true, 1).ok).toBe(false);
    });

    it("rejects a region in no decorator at all", () => {
      // `isDirectPropertyValue` carries no decorator-adjacency guarantee: a
      // plain `const o = { template: <div/> }` satisfies it.
      expect(at("template", [], true, null).ok).toBe(false);
    });

    it("reports the A4 message through the parser, positioned", () => {
      const source = [
        'import { Component } from "@angular/core";',
        "",
        "@Component({",
        "  styles: <div/>,",
        "})",
        "export class XComponent {}",
      ].join("\n");

      expect(() => compileNgMx(source, "/p/x.component.ng.mx")).toThrow(
        /only valid as the `template` property/,
      );
    });
  });

  describe("module-level IR (A4 divergence 4)", () => {
    /**
     * **Measured limitation, and it bounds what divergence 4 can deliver.**
     *
     * A4 says `Import`, `Static`, `Export` and `InputInterface` hoist out of
     * a region into the emitted module. The hoisting machinery here does
     * exactly that — but an author cannot currently *write* one of those tags
     * in a region, because a region sits in TypeScript **expression**
     * position and each of these is statement syntax. The surrounding
     * TypeScript parser rejects the file before MX ever sees the region:
     *
     *   `import …`  → "`import` can only be used in `import()` or `import.meta`."
     *   `static …`  → "Unexpected reserved word 'static'."
     *   `export …`  → "Unexpected token"
     *
     * All three are raised by the vendored Babel at the region's own start
     * offset, not by `@mxlang/core`. So the hoisting path is reachable today
     * only for a *synthesized* import (a discovered tag's, which the compiler
     * mints rather than the author writing it) — which is the case that
     * matters most, and the one `hoistedImports` covers.
     *
     * Escaping this needs the MX grammar to be entered before the TypeScript
     * statement check, which is a parser change, not a host one. Recorded as
     * an open question rather than worked around.
     */
    it("rejects an authored `import` inside a region, at the TS level", () => {
      const source = componentFile(
        'import { fmt } from "./fmt";\n    <p>${fmt(now)}</p>',
      );
      expect(() => compileNgMx(source, "/p/x.component.ng.mx")).toThrow(
        /`import` can only be used in/,
      );
    });

    it("rejects an authored `static` block inside a region, at the TS level", () => {
      const source = componentFile("static const MAX = 3;\n    <p>${MAX}</p>");
      expect(() => compileNgMx(source, "/p/x.component.ng.mx")).toThrow(
        /Unexpected reserved word 'static'/,
      );
    });

    it("rejects an authored `export` inside a region, at the TS level", () => {
      const source = componentFile(
        "export interface Input { a: string }\n    <p>x</p>",
      );
      expect(() => compileNgMx(source, "/p/x.component.ng.mx")).toThrow(
        /Unexpected token/,
      );
    });

    it("hoists a discovered tag's synthesized import into the module", () => {
      // The reachable half of divergence 4, exercised for real: a template
      // that *calls* a discovered tag. The previous version of this test
      // compiled a template with no tags at all and asserted `usedTags` was
      // empty, which proved nothing about hoisting.
      const dir = mkdtempSync(join(tmpdir(), "mx-ngmx-tag-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f" }));
        mkdirSync(join(dir, "tags"));
        writeFileSync(
          join(dir, "tags", "badge.mx"),
          '<span class="badge">x</span>\n',
        );
        const filePath = join(dir, "x.component.ng.mx");
        const source = componentFile("<div><badge/></div>");
        writeFileSync(filePath, source);

        const result = compileNgMx(source, filePath, {
          customTags: getCustomTags(filePath, {
            host: "angular",
            targets: angularOwnTargets,
          }),
        });

        // The tag reached the emitter…
        expect(result.usedTags.map((tag) => tag.className)).toContain("Badge");
        // …its import is hoisted into the module, pointing at the *emitted*
        // module rather than the `.mx` source…
        expect(result.code).toMatch(
          /import \{ Badge \} from "\.\/tags\/badge";/,
        );
        // …the class is declared in the decorator's own `imports:`…
        expect(result.code).toMatch(/imports: \[[^\]]*Badge/);
        // …the call site uses the tag's selector…
        expect(result.code).toContain("<mx-badge>");
        // …and MX does not also *tell* the author to add it, since it just did.
        expect(
          result.warnings.filter((w) => /Add to /.test(w.message)),
        ).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("@Component.imports (A4 divergence 5, task 2.1b)", () => {
    it("adds an `imports:` array naming a directive the template needs", () => {
      // An object-valued `class` lowers to `[ngClass]`, which obliges NgClass.
      const result = compileNgMx(
        componentFile("<div class={active: isOn}>x</div>"),
        "/p/x.component.ng.mx",
      );

      expect(result.code).toContain("imports:");
      expect(result.code).toContain("NgClass");
    });

    it("appends to an existing `imports:` without disturbing it", () => {
      const source = [
        'import { Component } from "@angular/core";',
        'import { Other } from "./other";',
        "",
        "@Component({",
        '  selector: "app-x",',
        "  imports: [Other],",
        "  template: <div class={active: isOn}>x</div>,",
        "})",
        "export class XComponent {}",
      ].join("\n");
      const result = compileNgMx(source, "/p/x.component.ng.mx");

      expect(result.code).toMatch(/imports: \[Other, NgClass\]/);
    });

    it("does not duplicate a symbol the author already listed", () => {
      const source = [
        'import { Component } from "@angular/core";',
        'import { NgClass } from "@angular/common";',
        "",
        "@Component({",
        '  selector: "app-x",',
        "  imports: [NgClass],",
        "  template: <div class={active: isOn}>x</div>,",
        "})",
        "export class XComponent {}",
      ].join("\n");
      const result = compileNgMx(source, "/p/x.component.ng.mx");

      expect(result.code.match(/NgClass/g)?.length).toBe(2); // the import + the one entry
      expect(result.code).toMatch(/imports: \[NgClass\]/);
    });
  });

  it("returns a source map against the .ng.mx file", () => {
    const result = compileNgMx(
      componentFile("<p>${name}</p>"),
      "/p/x.component.ng.mx",
    );

    // `MagicString` normalizes `source` to a basename, as it does for
    // `.solid.mx`'s own map — the sidecar resolves it against the emitted
    // file's directory, where the `.ng.mx` sits beside it.
    expect(result.map.sources).toContain("x.component.ng.mx");
    expect(result.map.mappings.length).toBeGreaterThan(0);
  });

  it("reports one region, spanning the source text it replaced", () => {
    const template = "<p>${name}</p>";
    const source = componentFile(template);
    const result = compileNgMx(source, "/p/x.component.ng.mx");

    expect(result.regions).toHaveLength(1);
    const [region] = result.regions;
    expect(source.slice(region?.start, region?.end)).toBe(template);
  });

  it("reports each region's template literal span in the emitted module", () => {
    const source = [
      'import { Component } from "@angular/core";',
      '@Component({ selector: "app-a", template: <p>${a}</p> })',
      "export class A { a = 1; }",
      '@Component({ selector: "app-b", template: <p>${a}</p> })',
      "export class B { a = 1; }",
    ].join("\n");
    const result = compileNgMx(source, "/p/x.component.ng.mx");

    expect(result.regions).toHaveLength(2);
    const slices = result.regions.map((r) =>
      result.code.slice(r.generatedStart, r.generatedEnd),
    );
    // Two regions emitting the same literal land at distinct offsets, each
    // slicing the module to a backtick template literal.
    expect(slices).toEqual(["`<p>{{ a }}</p>`", "`<p>{{ a }}</p>`"]);
    expect(result.regions[1]?.generatedStart).toBeGreaterThan(
      result.regions[0]?.generatedEnd ?? Infinity,
    );
  });

  it("maps each region's expressions back to the .ng.mx source (2.2b)", () => {
    // The flip this test was written to catch: mappings used to be `[]`
    // because the emitter was a plain string builder. It now records a span
    // per source-derived run, and `compileNgMx` rebases each region's spans
    // onto the finished module — so a generated offset slices the module to
    // the same text its source offset slices the `.ng.mx` to.
    const source = componentFile("<p>${name}</p>");
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    expect(result.mappings.length).toBeGreaterThan(0);
    const pairs = result.mappings.map((mapping) => ({
      generated: result.code.slice(
        mapping.generatedStart,
        mapping.generatedEnd,
      ),
      source: source.slice(mapping.sourceStart, mapping.sourceEnd),
    }));
    expect(pairs).toContainEqual({ generated: "name", source: "name" });
  });
});

describe("compileNgMx: round 1 review", () => {
  it("fills an existing but EMPTY `imports: []`", () => {
    // The array has no last element to append after, so an early return left
    // it empty while the `@angular/common` import was emitted anyway — the
    // directive imported, never declared, and the binding it powers
    // silently inert at runtime with no build error to notice.
    const source = [
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      '  selector: "app-x",',
      "  imports: [],",
      "  template: <div class={active: isOn}>x</div>,",
      "})",
      "export class XComponent { isOn = true; }",
    ].join("\n");
    const result = compileNgMx(source, "/p/x.component.ng.mx");

    expect(result.code).toMatch(/imports: \[NgClass\]/);
    expect(result.code).toContain('from "@angular/common"');
  });

  it("emits the @angular/common import for every directive it declares", () => {
    // `imports:` naming a symbol the module never imports is an unresolved
    // identifier: the emitted module does not compile at all.
    const result = compileNgMx(
      componentFile("<div class={active: isOn}>x</div>"),
      "/p/x.component.ng.mx",
    );

    expect(result.code).toMatch(
      /import \{[^}]*NgClass[^}]*\} from "@angular\/common";/,
    );
  });

  it("does not re-import a directive the author already imported", () => {
    const source = [
      'import { NgClass } from "@angular/common";',
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      '  selector: "app-x",',
      "  template: <div class={active: isOn}>x</div>,",
      "})",
      "export class XComponent { isOn = true; }",
    ].join("\n");
    const result = compileNgMx(source, "/p/x.component.ng.mx");

    expect(result.code.match(/from "@angular\/common"/g)).toHaveLength(1);
  });

  it("drops import advice by its code, not by its wording", () => {
    // Filtering on prose meant a reworded message would start leaking back
    // to authors, telling them to make an edit MX had already made.
    const result = compileNgMx(
      componentFile("<div class={active: isOn}>x</div>"),
      "/p/x.component.ng.mx",
    );

    expect(
      result.warnings.filter((w) =>
        /to the component's imports/.test(w.message),
      ),
    ).toEqual([]);
  });

  it("still reports warnings that are not import advice", () => {
    // The filter must not swallow everything: `$!{...}` warns for an
    // unrelated reason and has to survive.
    const result = compileNgMx(
      componentFile("<div>$!{raw}</div>"),
      "/p/x.component.ng.mx",
    );

    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("compileNgMx: round 2 review", () => {
  it("does not suppress a tag import because of an unrelated import from the same path", () => {
    // Tag imports used to be filtered by module *specifier* while
    // `imports:` was filtered by identifier *name*, so an authored import of
    // some other symbol from the tag's own path suppressed the tag import
    // while still declaring the class — an unresolved identifier.
    const dir = mkdtempSync(join(tmpdir(), "mx-ngmx-spec-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f" }));
      mkdirSync(join(dir, "tags"));
      writeFileSync(
        join(dir, "tags", "badge.mx"),
        '<span class="b">x</span>\n',
      );
      const filePath = join(dir, "x.component.ng.mx");
      const source = [
        'import { Component } from "@angular/core";',
        'import { SOMETHING_ELSE } from "./tags/badge";',
        "",
        "@Component({",
        '  selector: "app-x",',
        "  template: <div><badge/></div>,",
        "})",
        "export class XComponent {}",
      ].join("\n");
      writeFileSync(filePath, source);

      const result = compileNgMx(source, filePath, {
        customTags: getCustomTags(filePath, {
          host: "angular",
          targets: angularOwnTargets,
        }),
      });

      // Declared *and* imported, or the module does not compile.
      expect(result.code).toMatch(/imports: \[[^\]]*Badge/);
      expect(result.code).toMatch(/import \{ Badge \} from/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edits each @Component's own imports: in a two-component file", () => {
    // `usedTags`/`directives` are a union across regions, so taking the
    // first decorator gave component A the directives B needed and left B's
    // own array untouched — B's bindings silently inert.
    const source = [
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      '  selector: "app-a",',
      "  template: <div class={on: isOn}>a</div>,",
      "})",
      "export class AComponent { isOn = true; }",
      "",
      "@Component({",
      '  selector: "app-b",',
      "  template: <ul><for|k, v| in=items>{{ }}<li>${k}</li></for></ul>,",
      "})",
      "export class BComponent { items = {}; }",
    ].join("\n");

    const result = compileNgMx(source, "/p/x.component.ng.mx");

    // A gets NgClass (its own `class={...}`), B gets KeyValuePipe (its own
    // `<for in=>`) — and neither gets the other's.
    const [aBlock, bBlock] = result.code.split('selector: "app-b"');
    expect(aBlock).toMatch(/imports: \[[^\]]*NgClass/);
    expect(aBlock ?? "").not.toMatch(/imports: \[[^\]]*KeyValuePipe/);
    expect(bBlock).toMatch(/imports: \[[^\]]*KeyValuePipe/);
  });
});

describe("rebaseRegionMappings", () => {
  const mapping = {
    sourceStart: 0,
    sourceEnd: 1,
    generatedStart: 0,
    generatedEnd: 1,
  };

  it("offsets each region's mappings by where its literal landed", () => {
    const code = "aa `x` bb `y`";
    const out = rebaseRegionMappings(
      code,
      [
        { literal: "`x`", mappings: [mapping] },
        { literal: "`y`", mappings: [mapping] },
      ],
      "a.ng.mx",
    );
    expect(out.map((m) => m.generatedStart)).toEqual([3, 10]);
  });

  it("throws when a region's literal is not in the module, rather than dropping its mappings", () => {
    expect(() =>
      rebaseRegionMappings(
        "no literal here",
        [{ literal: "`x`", mappings: [mapping] }],
        "a.ng.mx",
      ),
    ).toThrow(/template literal is not present.*a\.ng\.mx/);
  });

  it("does not resolve two regions emitting the same literal to the first occurrence", () => {
    const out = rebaseRegionMappings(
      "`x` `x`",
      [
        { literal: "`x`", mappings: [mapping] },
        { literal: "`x`", mappings: [mapping] },
      ],
      "a.ng.mx",
    );
    expect(out.map((m) => m.generatedStart)).toEqual([0, 4]);
  });

  it("carries a mapping's derive tag through the rebase", () => {
    const out = rebaseRegionMappings(
      "`x`",
      [{ literal: "`x`", mappings: [{ ...mapping, derive: "selector" }] }],
      "a.ng.mx",
    );
    expect(out[0]?.derive).toBe("selector");
  });
});

describe("compileNgMx: standalone: false", () => {
  /** A component whose decorator opts out of standalone. */
  function ngModuleFile(template: string): string {
    return [
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      '  selector: "app-x",',
      "  standalone: false,",
      `  template: ${template},`,
      "})",
      "export class XComponent {}",
    ].join("\n");
  }

  it("does not inject imports: into a non-standalone component", () => {
    const result = compileNgMx(
      ngModuleFile("<div class={active: isOn}>x</div>"),
      "/p/x.component.ng.mx",
    );

    // Angular rejects `imports` on a non-standalone component.
    expect(result.code).not.toMatch(/imports:/);
    expect(result.code).not.toContain("NgClass");
    expect(result.code).toContain("standalone: false");
  });

  it("warns, positioned, naming what the NgModule must provide", () => {
    const result = compileNgMx(
      ngModuleFile("<div class={active: isOn}>x</div>"),
      "/p/x.component.ng.mx",
    );

    const warning = result.warnings.find((w) => /NgModule/.test(w.message));
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("NgClass");
    expect(warning?.message).toContain("@angular/common");
    expect(warning?.message).not.toMatch(/to the component's imports/);
    // The template region starts on line 6 (1-based), after `template: `.
    expect(warning?.line).toBe(6);
    expect(warning?.column).toBeGreaterThan(0);
  });

  it("is silent when the template needs nothing", () => {
    const result = compileNgMx(
      ngModuleFile("<div>x</div>"),
      "/p/x.component.ng.mx",
    );
    expect(result.warnings.filter((w) => /NgModule/.test(w.message))).toEqual(
      [],
    );
  });

  it("leaves standalone: true and an absent flag injecting imports:", () => {
    for (const flag of ["standalone: true,", ""]) {
      const source = ngModuleFile("<div class={active: isOn}>x</div>").replace(
        "standalone: false,",
        flag,
      );
      const result = compileNgMx(source, "/p/x.component.ng.mx");
      expect(result.code).toMatch(/imports: \[NgClass\]/);
      expect(result.warnings.filter((w) => /NgModule/.test(w.message))).toEqual(
        [],
      );
    }
  });

  it("names a discovered tag component the NgModule must provide", () => {
    const dir = mkdtempSync(join(tmpdir(), "ngmx-standalone-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f" }));
      mkdirSync(join(dir, "tags"));
      writeFileSync(
        join(dir, "tags", "badge.mx"),
        '<span class="badge">x</span>\n',
      );
      const filePath = join(dir, "x.component.ng.mx");
      const source = ngModuleFile("<div><badge/></div>");
      writeFileSync(filePath, source);
      const result = compileNgMx(source, filePath, {
        customTags: getCustomTags(filePath, {
          host: "angular",
          targets: angularOwnTargets,
        }),
      });
      expect(result.code).not.toMatch(/imports:/);
      const warning = result.warnings.find((w) => /NgModule/.test(w.message));
      expect(warning?.message).toContain("Badge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compileNgMx: standalone: false, round 2", () => {
  function withStandalone(
    entry: string,
    template = "<div class={active: isOn}>x</div>",
    pre = "",
  ): string {
    return [
      'import { Component } from "@angular/core";',
      pre,
      "@Component({",
      '  selector: "app-x",',
      `  ${entry},`,
      `  template: ${template},`,
      "})",
      "export class XComponent {}",
    ].join("\n");
  }
  const ngModuleWarnings = (code: string) =>
    compileNgMx(code, "/p/x.component.ng.mx").warnings.filter((w) =>
      /standalone/.test(w.message),
    );

  it("pins the exact line and column of the NgModule warning", () => {
    const [warning] = ngModuleWarnings(withStandalone("standalone: false"));
    // line 1 import, 2 blank, 3 @Component, 4 selector, 5 standalone, 6 template
    expect([warning?.line, warning?.column]).toEqual([6, 12]);
  });

  it("names the component class and its literal selector", () => {
    const [warning] = ngModuleWarnings(withStandalone("standalone: false"));
    expect(warning?.message).toContain("XComponent");
    expect(warning?.message).toContain('"app-x"');
  });

  it.each([
    ["quoted key", '"standalone": false'],
    ["as const", "standalone: false as const"],
    ["parenthesized", "standalone: (false)"],
    ["satisfies", "standalone: false satisfies boolean"],
    ["non-null", "standalone: false!"],
  ])("treats %s as standalone: false", (_name, entry) => {
    const result = compileNgMx(withStandalone(entry), "/p/x.component.ng.mx");
    expect(result.code).not.toMatch(/imports:/);
    expect(
      result.warnings.some((w) =>
        /declaring NgModule must provide/.test(w.message),
      ),
    ).toBe(true);
  });

  it.each([
    ["a variable", "standalone: FLAG", "const FLAG = false;"],
    ["a negation", "standalone: !true", ""],
    ["a call", "standalone: isStandalone()", ""],
  ])(
    "warns, positioned, and keeps standalone behaviour for %s",
    (_n, entry, pre) => {
      const result = compileNgMx(
        withStandalone(entry, undefined, pre),
        "/p/x.component.ng.mx",
      );
      expect(result.code).toMatch(/imports: \[NgClass\]/);
      const warning = result.warnings.find((w) =>
        /cannot determine/.test(w.message),
      );
      expect(warning?.message).toContain("XComponent");
      expect(warning?.message).toContain("assuming standalone");
      // The value of `standalone:` on the line before `template:`.
      const lines = withStandalone(entry, undefined, pre).split("\n");
      const at = lines.findIndex((l) => l.startsWith("  standalone"));
      expect(warning?.line).toBe(at + 1);
      expect(warning?.column).toBe((lines[at]?.indexOf(": ") as number) + 2);
    },
  );

  it("stays silent for literal true and an absent flag", () => {
    for (const entry of ["standalone: true", '"standalone": true']) {
      expect(ngModuleWarnings(withStandalone(entry))).toEqual([]);
    }
  });

  it("leaves a user-written imports: byte-untouched on a non-standalone component", () => {
    const source = [
      'import { Component } from "@angular/core";',
      "@Component({",
      '  selector: "app-x",',
      "  standalone: false,",
      "  imports: [Foo],",
      "  template: <div class={active: isOn}>x</div>,",
      "})",
      "export class XComponent {}",
    ].join("\n");
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    expect(result.code).toContain("  imports: [Foo],");
    expect(result.code).not.toContain("NgClass");
    expect(result.code).not.toContain("@angular/common");
  });

  it("handles a false and a standalone component in one file", () => {
    const source = [
      'import { Component } from "@angular/core";',
      "@Component({",
      '  selector: "app-a",',
      "  standalone: false,",
      "  template: <div class={a: b}>x</div>,",
      "})",
      "export class AComponent {}",
      "@Component({",
      '  selector: "app-b",',
      "  template: <div class={c: d}>x</div>,",
      "})",
      "export class BComponent {}",
    ].join("\n");
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    expect(result.code.match(/imports: \[NgClass\]/g)).toHaveLength(1);
    expect(result.code.match(/from "@angular\/common"/g)).toHaveLength(1);
    const own = result.warnings.filter((w) =>
      /declaring NgModule/.test(w.message),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.message).toContain("AComponent");
    expect(own[0]?.line).toBe(5);
  });
});

describe("compileNgMx: standalone warnings, round 3", () => {
  const tpl = "<div class={active: isOn}>x</div>";
  function file(
    head: string,
    decorators: string,
    klass: string,
    template = tpl,
  ): string {
    return [
      'import { Component } from "@angular/core";',
      head,
      "@Component({",
      '  selector: "app-x",',
      "  standalone: false,",
      `  template: ${template},`,
      "})",
      decorators,
      klass,
    ].join("\n");
  }
  const messages = (source: string) =>
    compileNgMx(source, "/p/x.component.ng.mx").warnings.map((w) => w.message);

  it("names an anonymous default-exported class, not `extends`", () => {
    const [message] = messages(
      file("", "", "export default class extends Base {}"),
    );
    expect(message).toContain("anonymous default-exported component");
    expect(message).not.toMatch(/^extends/);
  });

  it("names a named default-exported class", () => {
    const [message] = messages(
      file("", "", "export default class Named extends Base {}"),
    );
    expect(message).toMatch(/^Named /);
  });

  it("names the class past a second decorator", () => {
    const [message] = messages(file("", "@Other()", "export class Later {}"));
    expect(message).toMatch(/^Later /);
  });

  it("names the class past a comment before `class`", () => {
    const [message] = messages(
      file("", "/* note */ // more", "export class Commented {}"),
    );
    expect(message).toMatch(/^Commented /);
  });

  it("names an abstract or non-exported class", () => {
    expect(messages(file("", "", "abstract class Abs {}"))[0]).toMatch(/^Abs /);
    expect(messages(file("", "", "class Plain {}"))[0]).toMatch(/^Plain /);
  });

  it("does not warn `cannot determine` when nothing would be injected", () => {
    const source = file(
      "const FLAG = false;",
      "",
      "export class XComponent {}",
      "<div>x</div>",
    ).replace("standalone: false", "standalone: FLAG");
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    expect(
      result.warnings.filter((w) => /cannot determine/.test(w.message)),
    ).toEqual([]);
    expect(result.code).not.toMatch(/imports:/);
  });

  it("still warns `cannot determine` when imports are injected", () => {
    const source = file(
      "const FLAG = false;",
      "",
      "export class XComponent {}",
    ).replace("standalone: false", "standalone: FLAG");
    expect(
      messages(source).some((m) =>
        /cannot determine whether XComponent/.test(m),
      ),
    ).toBe(true);
  });

  it("words the warning accurately whether or not MX adds anything to imports:", () => {
    const base = file(
      "const FLAG = false;",
      "",
      "export class XComponent {}",
    ).replace("standalone: false,", "standalone: FLAG,");
    const added = messages(base);
    const listed = messages(
      base.replace(
        "standalone: FLAG,",
        "standalone: FLAG,\n  imports: [NgClass],",
      ),
    );
    for (const [message] of [added, listed]) {
      expect(message).toContain("cannot determine whether XComponent");
      expect(message).toContain("MX adds any missing");
      // Never claims an edit that may not have happened.
      expect(message).not.toContain("MX added");
    }
    // The author's own `imports:` already lists it, so nothing is added.
    const code = compileNgMx(
      base.replace(
        "standalone: FLAG,",
        "standalone: FLAG,\n  imports: [NgClass],",
      ),
      "/p/x.component.ng.mx",
    ).code;
    expect(code.match(/NgClass/g)?.length).toBeGreaterThanOrEqual(1);
    expect(code).toContain("imports: [NgClass]");
  });
});

describe("compileNgMx: event handlers", () => {
  it("writes the event invoker members into the decorated class and drops the advice", () => {
    const warnings: { message: string }[] = [];
    const result = compileNgMx(
      componentFile("<button onClick=cancel>x</button>", "\n  cancel() {}\n"),
      "/p/x.component.ng.mx",
      { warnings: warnings as never },
    );

    expect(result.code).toContain("protected readonly __mxOn = ");
    expect(result.code).toContain("protected readonly __mxOnAt = ");
    expect(emittedTemplate(result.code)).toBe(
      '<button (click)="__mxOn(cancel, this, $event)">x</button>',
    );
    expect(warnings.filter((w) => w.message.includes("__mxOn"))).toEqual([]);
    assertModuleTypechecks(result.code, "x.component.ts");
  });

  it("adds no members when the template binds no handler, or the author declared __mxOn", () => {
    expect(
      compileNgMx(componentFile("<div>x</div>"), "/p/x.component.ng.mx").code,
    ).not.toContain("__mxOn");
    const authored = compileNgMx(
      componentFile(
        "<button onClick=cancel>x</button>",
        "\n  cancel() {}\n  protected readonly __mxOn = null as never;\n",
      ),
      "/p/x.component.ng.mx",
    ).code;
    expect(authored.match(/__mxOn =/g)).toHaveLength(1);
  });
});

describe("compileNgMx: event invoker members already declared (per class, by AST)", () => {
  const HANDLER = "<button onClick=cancel>x</button>";
  const classFile = (body: string, before = "", after = "") =>
    [
      'import { Component } from "@angular/core";',
      before,
      "@Component({",
      '  selector: "app-x",',
      `  template: ${HANDLER},`,
      "})",
      `export class XComponent {${body}}`,
      after,
    ].join("\n");
  // Class-body declarations only (a line starting with the member), not the
  // template's own `__mxOn(...)` calls.
  const count = (code: string, name: string) =>
    code.match(
      new RegExp(
        `^\\s*(?:protected\\s+)?(?:readonly\\s+)?${name}\\b\\s*[=(<]`,
        "gm",
      ),
    )?.length ?? 0;
  const compileIt = (source: string) =>
    compileNgMx(source, "/p/x.component.ng.mx").code;

  it("injects only __mxOnAt when the class declares __mxOn as a property", () => {
    const code = compileIt(
      classFile(
        "\n  cancel() {}\n  protected readonly __mxOn = null as never;\n",
      ),
    );
    expect(count(code, "__mxOn")).toBe(1);
    expect(count(code, "__mxOnAt")).toBe(1);
  });

  it("injects only __mxOn when the class declares only __mxOnAt", () => {
    const code = compileIt(
      classFile(
        "\n  cancel() {}\n  protected readonly __mxOnAt = null as never;\n",
      ),
    );
    expect(count(code, "__mxOn")).toBe(1);
    expect(count(code, "__mxOnAt")).toBe(1);
  });

  it("injects nothing when the class declares both, in any spelling", () => {
    const code = compileIt(
      classFile(
        "\n  cancel() {}\n  __mxOn=null as never;\n  protected __mxOnAt(): void {}\n",
      ),
    );
    expect(count(code, "__mxOn")).toBe(1);
    expect(count(code, "__mxOnAt")).toBe(1);
  });

  it("is not suppressed by a comment, a string, or a later class", () => {
    const code = compileIt(
      classFile(
        "\n  cancel() {}\n  // __mxOn = old\n  note = '__mxOn = x';\n",
        "",
        "class Other { __mxOn = 1; __mxOnAt = 2; }",
      ),
    );
    expect(code.match(/protected readonly __mxOn = /g)).toHaveLength(1);
    expect(code.match(/protected readonly __mxOnAt = /g)).toHaveLength(1);
  });

  it("sees members inherited from a base class in the same file", () => {
    const both = compileIt(
      classFile("\n  cancel() {}\n", "class Base { __mxOn = 1; __mxOnAt = 2; }")
        .replace("class XComponent", "class XComponent")
        .replace(
          "export class XComponent {",
          "export class XComponent extends Base {",
        ),
    );
    expect(both.match(/protected readonly __mxOn/g)).toBeNull();
    const one = compileIt(
      classFile("\n  cancel() {}\n", "class Base { __mxOn = 1; }").replace(
        "export class XComponent {",
        "export class XComponent extends Base {",
      ),
    );
    expect(one.match(/protected readonly __mxOn = /g)).toBeNull();
    expect(one.match(/protected readonly __mxOnAt = /g)).toHaveLength(1);
  });

  it("follows a chain of visible base classes", () => {
    const code = compileIt(
      classFile(
        "\n  cancel() {}\n",
        "class Root { __mxOn = 1; __mxOnAt = 2; }\nclass Mid extends Root {}",
      ).replace(
        "export class XComponent {",
        "export class XComponent extends Mid {",
      ),
    );
    expect(code.match(/protected readonly __mxOn/g)).toBeNull();
  });

  it("injects both when the base is not visible in the file", () => {
    const code = compileIt(
      classFile("\n  cancel() {}\n").replace(
        "export class XComponent {",
        "export class XComponent extends Unknown(Base) {",
      ),
    );
    expect(code.match(/protected readonly __mxOn = /g)).toHaveLength(1);
    expect(code.match(/protected readonly __mxOnAt = /g)).toHaveLength(1);
  });

  describe("a base from @mxlang/host-angular/runtime", () => {
    const RT = "@mxlang/host-angular/runtime";
    const runtimeFile = (importLine: string, heritage: string, body = "") =>
      classFile(`\n  cancel() {}\n${body}`, importLine).replace(
        "export class XComponent {",
        `export class XComponent${heritage} {`,
      );
    const injected = (code: string) =>
      code.match(/protected readonly __mxOn(At)? = /g)?.length ?? 0;

    it("skips injection when the class extends MxHandlers", () => {
      const code = compileIt(
        runtimeFile(
          `import { MxHandlers } from "${RT}";`,
          " extends MxHandlers",
        ),
      );
      expect(injected(code)).toBe(0);
      expect(code).toContain('(click)="__mxOn(cancel, this, $event)"');
    });

    it("skips injection when the class extends MxHandlersMixin(Base)", () => {
      const code = compileIt(
        runtimeFile(
          `import { MxHandlersMixin } from "${RT}";\nclass Base {}`,
          " extends MxHandlersMixin(Base)",
        ),
      );
      expect(injected(code)).toBe(0);
    });

    it("follows an aliased import and a namespace import", () => {
      const aliased = compileIt(
        runtimeFile(`import { MxHandlers as H } from "${RT}";`, " extends H"),
      );
      expect(injected(aliased)).toBe(0);
      const ns = compileIt(
        runtimeFile(`import * as rt from "${RT}";`, " extends rt.MxHandlers"),
      );
      expect(injected(ns)).toBe(0);
      const nsMixin = compileIt(
        runtimeFile(
          `import * as rt from "${RT}";\nclass Base {}`,
          " extends rt.MxHandlersMixin(Base)",
        ),
      );
      expect(injected(nsMixin)).toBe(0);
    });

    it("follows a same-file base that itself extends MxHandlers", () => {
      const code = compileIt(
        runtimeFile(
          `import { MxHandlers } from "${RT}";\nclass Mid extends MxHandlers {}`,
          " extends Mid",
        ),
      );
      expect(injected(code)).toBe(0);
    });

    it("still injects when a same-named symbol is not from the runtime subpath", () => {
      const code = compileIt(
        runtimeFile(
          'import { MxHandlers } from "./my-handlers";',
          " extends MxHandlers",
        ),
      );
      expect(injected(code)).toBe(2);
    });

    it("still injects for a local class that merely shares the name", () => {
      const code = compileIt(
        runtimeFile("class MxHandlers {}", " extends MxHandlers"),
      );
      expect(injected(code)).toBe(2);
    });

    // Only three heritage shapes count, each resolved through an import from
    // the runtime subpath: `extends X`, `extends X(...)`, `extends ns.X` /
    // `extends ns.X(...)`. Anything else keeps injection.
    it("skips for the call shape with any arguments, and for ns.X(...)", () => {
      const call = compileIt(
        runtimeFile(
          `import { MxHandlersMixin as M } from "${RT}";\nclass Base {}`,
          " extends M(Base)",
        ),
      );
      expect(injected(call)).toBe(0);
      const nsCall = compileIt(
        runtimeFile(
          `import * as rt from "${RT}";\nclass Base {}`,
          " extends rt.MxHandlersMixin(class extends Base {})",
        ),
      );
      expect(injected(nsCall)).toBe(0);
    });

    it("still injects for other.MxHandlers when `other` is not a namespace import of the runtime", () => {
      expect(
        injected(
          compileIt(
            runtimeFile(
              `import * as other from "./other";\nimport { MxHandlers } from "${RT}";\nvoid MxHandlers;`,
              " extends other.MxHandlers",
            ),
          ),
        ),
      ).toBe(2);
      // A default or named import called `rt` is not a namespace either.
      expect(
        injected(
          compileIt(
            runtimeFile(
              `import { rt } from "${RT}";`,
              " extends rt.MxHandlers",
            ),
          ),
        ),
      ).toBe(2);
    });

    it("still injects when the runtime name is only mentioned inside the heritage expression", () => {
      const code = compileIt(
        runtimeFile(
          `import { MxHandlers } from "${RT}";\nconst Foo = (f: () => unknown) => class {};\nvoid MxHandlers;`,
          " extends Foo(() => MxHandlers)",
        ),
      );
      expect(injected(code)).toBe(2);
    });

    // Pinned current behaviour (indirect bases): injection still happens, and
    // TypeScript then reports a conflict (TS2415). The docs say to extend the
    // runtime directly.
    it("still injects for an indirect base: an alias, a cross-file or re-exported base, a wrapped mixin", () => {
      const alias = compileIt(
        runtimeFile(
          `import { MxHandlers } from "${RT}";\nconst B = MxHandlers;`,
          " extends B",
        ),
      );
      expect(injected(alias)).toBe(2);
      const crossFile = compileIt(
        runtimeFile('import { Base } from "./base";', " extends Base"),
      );
      expect(injected(crossFile)).toBe(2);
      const reExported = compileIt(
        runtimeFile(
          `export { MxHandlers as Handlers } from "${RT}";\nimport { Handlers } from "./handlers";`,
          " extends Handlers",
        ),
      );
      expect(injected(reExported)).toBe(2);
      const wrapped = compileIt(
        runtimeFile(
          `import { MxHandlersMixin } from "${RT}";\nclass Base {}\nconst Other = <T>(b: T) => b;`,
          " extends Other(MxHandlersMixin(Base))",
        ),
      );
      expect(injected(wrapped)).toBe(2);
    });

    it("decides per class: only the class that extends the runtime skips", () => {
      const source = [
        'import { Component } from "@angular/core";',
        `import { MxHandlers } from "${RT}";`,
        "@Component({",
        '  selector: "app-a",',
        `  template: ${HANDLER},`,
        "})",
        "export class A extends MxHandlers {}",
        "@Component({",
        '  selector: "app-b",',
        `  template: ${HANDLER},`,
        "})",
        "export class B {}",
      ].join("\n");
      expect(injected(compileIt(source))).toBe(2);
    });

    it("emits no advice warning either way", () => {
      const warnings: { message: string }[] = [];
      compileNgMx(
        runtimeFile(
          `import { MxHandlers } from "${RT}";`,
          " extends MxHandlers",
        ),
        "/p/x.component.ng.mx",
        { warnings: warnings as never },
      );
      expect(warnings.filter((w) => w.message.includes("__mxOn"))).toEqual([]);
    });
  });

  it("decides per class: a second decorated class is judged on its own members", () => {
    const source = [
      'import { Component } from "@angular/core";',
      "@Component({",
      '  selector: "app-a",',
      `  template: ${HANDLER},`,
      "})",
      "export class A { __mxOn = 1; __mxOnAt = 2; }",
      "@Component({",
      '  selector: "app-b",',
      `  template: ${HANDLER},`,
      "})",
      "export class B {}",
    ].join("\n");
    const code = compileIt(source);
    expect(code.match(/protected readonly __mxOn = /g)).toHaveLength(1);
    expect(code.match(/protected readonly __mxOnAt = /g)).toHaveLength(1);
    expect(code.indexOf("protected readonly __mxOn = ")).toBeGreaterThan(
      code.indexOf("export class B"),
    );
  });
});

describe("compileNgMx: region padding follows parseFragment's contract", () => {
  const base = (preamble: string) => {
    const lines = preamble.split("\n");
    return {
      baseOffset: preamble.length,
      baseLine: lines.length - 1,
      baseColumn: lines[lines.length - 1]?.length ?? 0,
    };
  };
  const PREAMBLE = [
    'import { Component } from "@angular/core";',
    "",
    `const filler = "${"x".repeat(70)}";`,
    "@Component({",
    '  selector: "app-x",',
    "  template: ",
  ].join("\n");

  it("puts exactly baseColumn filler before the region on its own line", () => {
    const region = '<div class="a">x</div>';
    const b = base(PREAMBLE);
    const padded = positionRegionSource(region, b).padded;
    const lines = padded.split("\n");
    expect(lines.length - 1).toBe(b.baseLine);
    expect(lines[b.baseLine]).toBe(`${" ".repeat(b.baseColumn)}${region}`);
  });

  it("makes a (line, column) walk of the region's first character land on baseOffset", () => {
    const region = "<p>x</p>";
    const b = base(PREAMBLE);
    const padded = positionRegionSource(region, b).padded;
    const lines = padded.split("\n");
    let offset = 0;
    for (let line = 0; line < b.baseLine; line++) {
      offset += (lines[line]?.length ?? 0) + 1;
    }
    // `offsetOf`'s walk: preceding line lengths, then the file column.
    expect(offset + b.baseColumn).toBe(b.baseOffset);
    expect(padded.length - region.length).toBe(b.baseOffset);
  });

  it("slices static, bound and boolean attribute names exactly, after line 1 with a long preamble", () => {
    const source = `${PREAMBLE}<div class="a" id="b" title=x disabled>\${x}</div>,\n})\nexport class XComponent { x = 1; }\n`;
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    const pairs = new Map(
      result.mappings.map((m) => [
        result.code.slice(m.generatedStart, m.generatedEnd),
        source.slice(m.sourceStart, m.sourceEnd),
      ]),
    );
    for (const name of ["class", "id", "title", "disabled"]) {
      expect(pairs.get(name)).toBe(name);
    }
  });

  it("slices attribute names exactly on every line of a multi-line region", () => {
    // The case that mapped `class`/`id`/`title` to `olid-`, `\nc`, `fille`:
    // the first attribute shares the region's first line, the rest follow.
    const region = [
      '<section class="wrap"',
      '  id="main"',
      "  title=x",
      ">${x}</section>",
    ].join("\n");
    const source = `${PREAMBLE}${region},\n})\nexport class XComponent { x = 1; }\n`;
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    const pairs = new Map(
      result.mappings.map((m) => [
        result.code.slice(m.generatedStart, m.generatedEnd),
        source.slice(m.sourceStart, m.sourceEnd),
      ]),
    );
    for (const name of ["class", "id", "title"]) {
      expect(pairs.get(name)).toBe(name);
    }
  });

  it("slices attribute names of a single-root region and of a second sibling element", () => {
    // Before the padding fix every first-line attribute name of every region
    // resolved into unrelated text, single-root included.
    const cases: Array<[string, string[]]> = [
      ['<a class="x" title="t">${x}</a>', ["class", "title"]],
      ['<a class="x"/><b id="y"/>', ["class", "id"]],
    ];
    for (const [region, names] of cases) {
      // A sibling pair is not a single expression, so wrap it the way an author
      // must: the region is one root, siblings sit inside it.
      const template = region.startsWith('<a class="x"/>')
        ? `<div>${region}</div>`
        : region;
      const source = `${PREAMBLE}${template},\n})\nexport class XComponent { x = 1; }\n`;
      const result = compileNgMx(source, "/p/x.component.ng.mx");
      const pairs = new Map(
        result.mappings.map((m) => [
          result.code.slice(m.generatedStart, m.generatedEnd),
          source.slice(m.sourceStart, m.sourceEnd),
        ]),
      );
      for (const name of names) expect(pairs.get(name)).toBe(name);
    }
  });
});

// G9 (`angular-ngmx-multi-root`): an Angular template may have several roots,
// and a region has exactly one. `<>…</>` is the spelling for several: the
// parser treats it as a fragment *region* here (`mxRegionFragment`, which
// only this host turns on), and the host lowers its children as siblings —
// the same lowering a page template with several roots gets.
describe("compileNgMx: fragment regions (G9)", () => {
  /** [authored region, the template it lowers to]. */
  const lowered: Array<[string, string]> = [
    ["<></>", ""],
    // Decision 141: retained text uses Angular's non-droppable space marker.
    ["<>   </>", "&ngsp;"],
    ["<>hello</>", "hello"],
    ["<>hello ${name}</>", "hello {{ name }}"],
    ["<>${name}</>", "{{ name }}"],
    ["<><b>hi</b><i>x</i></>", "<b>hi</b><i>x</i>"],
    ["<>\n  <b>hi</b>\n  <i>x</i>\n</>", "<b>hi</b><i>x</i>"],
    ["<><ng-content/><b>hi</b></>", "<ng-content></ng-content><b>hi</b>"],
    [
      "<><if=a><b/></if><if=b><i/></if></>",
      "@if (a) { <b></b> }@if (b) { <i></i> }",
    ],
    ["<><b>a</b> tail</>", "<b>a</b> tail"],
    // `</>` inside an expression is not the fragment's close.
    ['<>${"</>"}</>', '{{ "</>" }}'],
  ];

  for (const [region, template] of lowered) {
    it(`lowers ${JSON.stringify(region)} to sibling nodes`, () => {
      const result = compileNgMx(componentFile(region), "/p/x.component.ng.mx");
      expect(emittedTemplate(result.code)).toBe(template);
      // Nothing of the fragment syntax survives, and the module still reads
      // as the author's: the decorator and class are untouched.
      expect(result.code).not.toMatch(/template: <>/);
      expect(result.code).toContain("export class XComponent");
    });
  }

  it("emits a template the real Angular compiler parses", () => {
    const result = compileNgMx(
      componentFile(
        "<>\n  <ng-content/>\n  <if=open><b>hi</b></if>\n  <for|p| of=people by=(p => p.id)><li>${p.name}</li></for>\n</>",
      ),
      "/p/x.component.ng.mx",
    );
    const parsed = parseTemplate(emittedTemplate(result.code), "x.html");
    expect(parsed.errors).toBeNull();
    expect(parsed.nodes.length).toBeGreaterThan(2);
  });

  it("emits a module that typechecks", () => {
    const result = compileNgMx(
      componentFile("<><b>${name}</b><i>${name}</i></>", " name = 'x';"),
      "/p/x.component.ng.mx",
    );
    assertModuleTypechecks(result.code);
  });

  it("reports the whole `<>…</>` as the region's span", () => {
    const source = componentFile("<><b>hi</b><i>x</i></>");
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    const [region] = result.regions;
    expect(source.slice(region?.start, region?.end)).toBe(
      "<><b>hi</b><i>x</i></>",
    );
  });

  it("maps each sibling's expressions back to the .ng.mx source", () => {
    const source = componentFile(
      "<>\n  <p>${first}</p>\n  <p title=second>x</p>\n</>",
    );
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    const pairs = result.mappings.map((mapping) => ({
      generated: result.code.slice(
        mapping.generatedStart,
        mapping.generatedEnd,
      ),
      source: source.slice(mapping.sourceStart, mapping.sourceEnd),
    }));
    expect(pairs).toContainEqual({ generated: "first", source: "first" });
    expect(pairs).toContainEqual({ generated: "second", source: "second" });
  });

  it("adds the directives a fragment's children need to imports", () => {
    const result = compileNgMx(
      componentFile("<><div class={ on: flag }/><b/></>"),
      "/p/x.component.ng.mx",
    );
    expect(result.code).toContain("NgClass");
    expect(result.code).toMatch(/imports: \[[^\]]*NgClass/);
  });

  it("lowers a fragment region beside an ordinary one in the same module", () => {
    const source = [
      'import { Component } from "@angular/core";',
      '@Component({ selector: "app-a", template: <><b>a</b><i>a</i></> })',
      "export class A {}",
      '@Component({ selector: "app-b", template: <p>b</p> })',
      "export class B {}",
    ].join("\n");
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    expect(result.code).toContain("template: `<b>a</b><i>a</i>`");
    expect(result.code).toContain("template: `<p>b</p>`");
  });

  it("refuses a fragment nested in a fragment, naming the rule", () => {
    expect(() =>
      compileNgMx(componentFile("<><><b/></></>"), "/p/x.component.ng.mx"),
    ).toThrow(
      "A fragment `<>…</>` cannot contain another fragment. Its children are already siblings.",
    );
  });

  it("refuses an unterminated fragment, naming the fragment", () => {
    expect(() =>
      compileNgMx(componentFile("<><b/>"), "/p/x.component.ng.mx"),
    ).toThrow("Unterminated fragment: expected a closing `</>`.");
  });

  // In a `.ng.mx` file a fragment is MX syntax, not TSX. Outside `template:`
  // it used to parse as a TSX fragment and be emitted as raw `<>`, invalid
  // TypeScript; it is now an error that says where a fragment may go.
  it.each([" x = <></>;", " x = f(<>a</>);"])(
    "rejects a fragment outside `template:`: %j",
    (extra) => {
      const source = componentFile("<p/>", extra);
      const error = thrown(() => compileNgMx(source, "/p/x.component.ng.mx"));
      expect(error.message.startsWith(NG_MX_FRAGMENT_POSITION_MESSAGE)).toBe(
        true,
      );
      // Positioned at the fragment's `<`, on the error's own `loc`
      // (1-based line, 0-based column) rather than in its text.
      expect(error.message).not.toMatch(/\(\d+:\d+\)$/);
      const loc = error.loc as { line: number; column: number };
      const line = source.split("\n")[loc.line - 1] ?? "";
      expect(line.slice(loc.column)).toMatch(/^<>/);
    },
  );

  it("names the fragment rule exactly", () => {
    expect(NG_MX_FRAGMENT_POSITION_MESSAGE).toBe(
      "in a `.ng.mx` file a fragment `<>…</>` is only allowed as the root of the `template:` region of an `@Component({ … })` decorator.",
    );
  });

  it("still rejects a non-fragment region outside `template:` with the position message", () => {
    const source = componentFile("<p/>", "").replace(
      "export class XComponent {}",
      "export class XComponent { x = <b/>; }",
    );
    expect(() => compileNgMx(source, "/p/x.component.ng.mx")).toThrow(
      NG_MX_POSITION_MESSAGE,
    );
  });
  it("refuses a fragment nested inside an element child, naming the rule", () => {
    expect(() =>
      compileNgMx(
        componentFile("<><div><></></div></>"),
        "/p/x.component.ng.mx",
      ),
    ).toThrow(
      "A fragment `<>…</>` cannot contain another fragment. Its children are already siblings.",
    );
  });

  // The fragment is read inside a wrapper node. If the wrapper could resolve as
  // a project tag, that tag's parse options would change how the author's
  // children are read. It is a dynamic tag, which no taglib entry can name.
  it.each(["f", "_", "0", "fragment", "mx-fragment"])(
    "is not affected by a project tag named %j",
    (name) => {
      const result = compileNgMx(
        componentFile("<><b>x</b>\n  <i>y</i></>"),
        "/p/x.component.ng.mx",
        {
          customTags: {
            [name]: { parseOptions: { text: true } },
          } as never,
        },
      );
      const plain = compileNgMx(
        componentFile("<><b>x</b>\n  <i>y</i></>"),
        "/p/x.component.ng.mx",
      );
      expect(emittedTemplate(result.code)).toBe(emittedTemplate(plain.code));
      expect(emittedTemplate(result.code)).toBe("<b>x</b><i>y</i>");
    },
  );

  // Name spans on the 2nd+ sibling, on later lines of a multi-line fragment.
  // Asserts the CORRECT spans: the generated text a mapping selects and the
  // source text it claims are the same word. The wrapper shifts only the first
  // line's columns (see `lowerRegion`), so a later line is where a wrong
  // adjustment would show.
  it("maps names and expressions on later lines of a multi-line fragment", () => {
    const source = componentFile(
      '<>\n  <p class="a">${first}</p>\n\n  <a href=link title="t">x</a>\n</>',
    );
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    const pairs = result.mappings.map((mapping) => ({
      generated: result.code.slice(
        mapping.generatedStart,
        mapping.generatedEnd,
      ),
      source: source.slice(mapping.sourceStart, mapping.sourceEnd),
    }));
    for (const word of ["first", "link", "href", "title"]) {
      expect(pairs).toContainEqual({ generated: word, source: word });
    }
  });
  // Attribute-name spans when the name is on the SAME line as the region
  // start (region at line 5, col 12, after four module lines). Asserts the
  // CORRECT span: the generated text and the source text are both `class`.
  // Before #176 fixed `positionedSource` these mapped unrelated text; the
  // single-root case shows that was never fragment-specific.
  it.each([
    ["a fragment", '<><i/><b class="k">x</b></>'],
    ["a single root", '<b class="k">x</b>'],
  ])("maps a same-line attribute name in %s", (_kind, region) => {
    const source = componentFile(region);
    const result = compileNgMx(source, "/p/x.component.ng.mx");
    const pairs = result.mappings.map((mapping) => ({
      generated: result.code.slice(
        mapping.generatedStart,
        mapping.generatedEnd,
      ),
      source: source.slice(mapping.sourceStart, mapping.sourceEnd),
    }));
    expect(pairs).toContainEqual({ generated: "class", source: "class" });
  });
  // The fragment adjustment must compose with `positionRegionSource`: every
  // name and expression maps to itself, whether it is the first child or a
  // later sibling, on the fragment's own line or a later one, and wherever the
  // `<>` sits, including columns 0 and 1 (where the wrapper's shift would go
  // negative if applied to the wrong quantity).
  describe("mappings compose with the region padding", () => {
    /** `component` with the template value starting after `lead`. */
    const at = (lead: string, region: string) =>
      [
        'import { Component } from "@angular/core";',
        "",
        "@Component({",
        '  selector: "app-x",',
        `  template:${lead}${region},`,
        "})",
        "export class XComponent {}",
      ].join("\n");
    const cases: Array<[string, string, string, string[]]> = [
      [
        "first child, same line",
        " ",
        '<>${aa}<p title=bb class="k">x</p></>',
        ["aa", "bb", "title", "class"],
      ],
      [
        "later sibling, same line",
        " ",
        '<><i/><b class="k" id=cc>x</b></>',
        ["class", "cc", "id"],
      ],
      [
        "later lines",
        " ",
        '<>\n  <i title=dd/>\n  <b class="k" id=ee>${ff}</b>\n</>',
        ["title", "dd", "class", "id", "ee", "ff"],
      ],
      [
        "`<>` at column 0",
        "\n",
        '<><i title=gg/><b class="k">x</b></>',
        ["title", "gg", "class"],
      ],
      [
        "`<>` at column 1",
        "\n ",
        '<><i title=hh/><b class="k">x</b></>',
        ["title", "hh", "class"],
      ],
      [
        "`<>` at column 0 with later lines",
        "\n",
        '<>\n<i title=ii/>\n<b class="k">${jj}</b></>',
        ["title", "ii", "class", "jj"],
      ],
    ];
    it.each(cases)("%s", (_name, lead, region, words) => {
      const source = at(lead, region);
      const result = compileNgMx(source, "/p/x.component.ng.mx");
      const pairs = result.mappings.map((mapping) => ({
        generated: result.code.slice(
          mapping.generatedStart,
          mapping.generatedEnd,
        ),
        source: source.slice(mapping.sourceStart, mapping.sourceEnd),
      }));
      for (const word of words) {
        expect(pairs).toContainEqual({ generated: word, source: word });
      }
      // No mapping may select different text on the two sides.
      expect(pairs.filter((pair) => pair.generated !== pair.source)).toEqual(
        [],
      );
    });
  });
});

// Several bare roots are still an error, but one that names the rule and the
// way out. The rewrite happens in the parser and only ever replaces a failure:
// what parsed before must parse now, unchanged.
describe("compileNgMx: several bare roots (G9)", () => {
  const RULE =
    "An MX region has exactly one root element. Wrap sibling elements in a fragment, `<>…</>`.";

  // The position rides on `loc` (1-based line, 0-based column); the text
  // carries no `(L:C)` any more, since a printed position is 1-based
  // (ruling #227) and this one is not the diagnostic's own.
  it.each([
    ["<b/><c/>", { line: 5, column: 16 }],
    ["<b>a</b> <i>b</i>", { line: 5, column: 21 }],
    ["<b/>\n<c/>", { line: 6, column: 0 }],
    ["<if=a>x</if><if=b>y</if>", { line: 5, column: 24 }],
    ["<ng-content/><b>hi</b>", { line: 5, column: 25 }],
  ])("rejects %j, naming the rule at the second root", (region, loc) => {
    const error = thrown(() =>
      compileNgMx(componentFile(region), "/p/x.component.ng.mx"),
    );
    expect(error.message).toBe(RULE);
    expect(error.loc).toMatchObject(loc);
  });

  // Each of these parsed before the rewrite existed (TypeScript reads the
  // second `<` as a comparison). They must keep parsing, to the same output.
  it.each([
    ["<b/> < c", "`<b></b>` < c"],
    ["<b/> <c", "`<b></b>` <c"],
    ["<b/> <c>", "`<b></b>` <c>"],
    ["<b/> > c", "`<b></b>` > c"],
  ])("still parses %j exactly as before", (region, expected) => {
    const result = compileNgMx(componentFile(region), "/p/x.component.ng.mx");
    expect(result.code).toContain(`template: ${expected},`);
  });
});
