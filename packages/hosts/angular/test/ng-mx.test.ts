import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplate } from "@angular/compiler";
import { getCustomTags } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import {
  compileNgMx,
  escapeTemplateLiteral,
  NG_MX_POSITION_MESSAGE,
  ngMxPositionCheck,
} from "../src/ng-mx.ts";

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
          customTags: getCustomTags(filePath, { host: "angular" }),
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

  it("keeps template mappings empty until 2.2b fills them", () => {
    // The seam, asserted rather than assumed: the Angular emitter is a string
    // builder with no `mapped(...)` call, so there is nothing to derive
    // mappings from yet (spike §Q3). When 2.2b lands this expectation flips,
    // which is the point — a silent change here would be a regression.
    const result = compileNgMx(
      componentFile("<p>${name}</p>"),
      "/p/x.component.ng.mx",
    );
    expect(result.mappings).toEqual([]);
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
        customTags: getCustomTags(filePath, { host: "angular" }),
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
