import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Test-only introspection, deliberately not part of the package's public API.
import { getProgramReuseCount } from "./checker.ts";
import { createAngularChecker, typescriptVersion } from "./index.ts";

/**
 * `projectDir` is this package's own directory, so `@angular/core` resolves
 * through its nested `node_modules` -- the same resolution a consumer gets when
 * it points the checker at a real Angular project.
 */
const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const VIRTUAL = path.join(PROJECT_DIR, "virtual.component.ts");

/** Wrap a template in a standalone component whose `user` has only `name`. */
function component(template: string, klass = "VComponent"): string {
  return `import { Component } from "@angular/core";
@Component({ selector: "app-v", standalone: true, template: \`${template}\` })
export class ${klass} { user = { name: "a" }; }
`;
}

/** Offset of the first character after the opening backtick of the template. */
function templateStart(source: string, template: string): number {
  return source.indexOf(`\`${template}`) + 1;
}

describe("angular core types", () => {
  it("resolves @angular/core from the project dir", () => {
    // THE PRECONDITION FOR EVERY OTHER TEST HERE. Without @angular/core's real
    // types, a template using Angular's own API (a signal input, `signal()`)
    // has nothing to type-check against, so a deliberately-broken one reports
    // ZERO diagnostics and reads as clean -- the silent-zero trap, arriving by
    // a second route. Measured in an environment with compiler-cli but no
    // core: `{{ u().nmae }}` yields 0 ngtsc diagnostics instead of 1.
    // `@angular/core` is a devDependency of this package for exactly this.
    const require = createRequire(import.meta.url);
    expect(() => require.resolve("@angular/core")).not.toThrow();
  });
});

describe("createAngularChecker", () => {
  it("runs against a typescript inside compiler-cli's peer range", () => {
    // @angular/compiler-cli@22.1.7 requires typescript >=6.0 <6.1. If this
    // ever reads something else, the workspace pin has drifted out of that
    // range and every diagnostic below is running on an unsupported compiler.
    expect(typescriptVersion).toMatch(/^6\.0\./);
  });

  it("reports a diagnostic for a known-bad template", () => {
    // THE TRAP (spike Q1): a host that cannot read the virtual file yields zero
    // diagnostics and no error, which is indistinguishable from success. This
    // test is the guard -- a known-bad template MUST produce a diagnostic.
    const template = "<span>{{ user.nmae }}</span>";
    const source = component(template);

    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(VIRTUAL, source);
    checker.dispose();

    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    const [first] = diagnostics;
    expect(first?.message).toContain("nmae");
    expect(first?.source).toBe("ngtsc");
    expect(first?.category).toBe("error");

    // The offset lands inside the template literal, not somewhere in the
    // surrounding module.
    const start = templateStart(source, template);
    expect(first?.start).toBeGreaterThan(start);
    expect(first?.start).toBeLessThan(start + template.length);
  });

  it("reports no diagnostics for a good template", () => {
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(
      VIRTUAL,
      component("<span>{{ user.name }}</span>"),
    );
    checker.dispose();

    expect(diagnostics).toEqual([]);
  });

  it("keeps offsets 1:1 with the template across multiple lines", () => {
    // Ruling c: templates are emitted as backtick literals, so no escaping
    // happens and the offset hop is the identity -- even past newlines and a
    // double quote, both of which would shift offsets in a quoted string.
    const template = `<a title="q">x</a>
<b>plain</b>
<i>{{ user.nmae }}</i>`;
    const source = component(template);

    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(VIRTUAL, source);
    checker.dispose();

    const [first] = diagnostics;
    expect(first).toBeDefined();

    const offsetInTemplate =
      (first?.start ?? 0) - templateStart(source, template);
    // Identity: the offset indexes the RAW template text directly.
    expect(offsetInTemplate).toBe(template.indexOf("nmae"));
    expect(template.slice(offsetInTemplate, offsetInTemplate + 4)).toBe("nmae");
  });

  it("reuses the program across checks instead of recompiling from cold", () => {
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    // Two counters, because one alone proves too little. `compileCount` says
    // how many compilations ran; `getProgramReuseCount` says how many of those
    // were constructed with a non-undefined `oldProgram` -- the actual reuse
    // claim. Counting rather than timing: the spike measured a ~7x spread
    // under contention, so a timing assertion would be flaky.
    const counted = checker as unknown as { compileCount(): number };
    const reuseBefore = getProgramReuseCount();

    checker.check(VIRTUAL, component("<span>{{ user.name }}</span>"));
    expect(counted.compileCount()).toBe(1);
    // The first check has no previous program, so it cannot have reused one.
    expect(getProgramReuseCount()).toBe(reuseBefore);

    // An edit, then a re-check: one more compilation, and this one really is
    // handed the first call's program.
    const second = checker.check(VIRTUAL, component("<b>{{ user.nmae }}</b>"));
    expect(counted.compileCount()).toBe(2);
    expect(getProgramReuseCount()).toBe(reuseBefore + 1);
    expect(second.length).toBeGreaterThanOrEqual(1);

    // A third confirms it keeps reusing rather than reusing once.
    checker.check(VIRTUAL, component("<i>{{ user.name }}</i>"));
    expect(getProgramReuseCount()).toBe(reuseBefore + 2);

    checker.dispose();
  });

  it("resolves without throwing when cancelled mid-run", () => {
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });

    // Cancelled from the very first poll: the run is abandoned, and the caller
    // gets an empty list rather than an exception.
    const alwaysCancelled = { isCancelled: () => true };
    expect(() =>
      checker.check(
        VIRTUAL,
        component("<span>{{ user.nmae }}</span>"),
        alwaysCancelled,
      ),
    ).not.toThrow();
    expect(
      checker.check(
        VIRTUAL,
        component("<span>{{ user.nmae }}</span>"),
        alwaysCancelled,
      ),
    ).toEqual([]);

    // Cancelling partway through (after the first poll passes) also resolves
    // cleanly rather than leaving the checker unusable.
    let polls = 0;
    const cancelsLater = {
      isCancelled: () => {
        polls += 1;
        return polls > 1;
      },
    };
    expect(() =>
      checker.check(
        VIRTUAL,
        component("<span>{{ user.nmae }}</span>"),
        cancelsLater,
      ),
    ).not.toThrow();

    // And the checker still works normally afterwards.
    const after = checker.check(
      VIRTUAL,
      component("<span>{{ user.nmae }}</span>"),
    );
    expect(after.length).toBeGreaterThanOrEqual(1);

    checker.dispose();
  });

  it("checks the contents passed to update, not what was checked before", () => {
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });

    expect(
      checker.check(VIRTUAL, component("<span>{{ user.name }}</span>")),
    ).toEqual([]);

    // A second file that imports nothing but is checked on its own.
    const other = path.join(PROJECT_DIR, "other.component.ts");
    checker.update(
      other,
      component("<span>{{ user.nmae }}</span>", "OtherComponent"),
    );

    expect(
      checker.check(
        other,
        component("<span>{{ user.nmae }}</span>", "OtherComponent"),
      ).length,
    ).toBeGreaterThanOrEqual(1);

    checker.dispose();
  });

  it("catches a bad property on a signal input's type", () => {
    // The brief's acceptance shape, and the case that silently passed before
    // @angular/core was a devDependency: without core's types `input({...})`
    // is untyped, so `nmae` has nothing to be wrong against.
    const source = `import { Component, input } from "@angular/core";
@Component({ selector: "app-s", standalone: true, template: \`{{ u().nmae }}\` })
export class SComponent { u = input({ name: "a" }); }
`;
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(VIRTUAL, source);
    checker.dispose();

    const ng = diagnostics.filter((d) => d.source === "ngtsc");
    expect(ng.length).toBeGreaterThanOrEqual(1);
    expect(ng.some((d) => d.code === 2339)).toBe(true);
    expect(ng[0]?.message).toContain("nmae");
  });

  it("catches a bad property on a signal()'s type", () => {
    const source = `import { Component, signal } from "@angular/core";
@Component({ selector: "app-g", standalone: true, template: \`{{ s().nmae }}\` })
export class GComponent { s = signal({ name: "a" }); }
`;
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(VIRTUAL, source);
    checker.dispose();

    const ng = diagnostics.filter((d) => d.source === "ngtsc");
    expect(ng.some((d) => d.code === 2339)).toBe(true);
    expect(ng[0]?.message).toContain("nmae");
  });

  it("checks inside @if and @for control flow blocks", () => {
    // The acceptance template from the brief: @if, @for with track, and a
    // required signal input, with the error inside the @for body.
    const source = `import { Component, input } from "@angular/core";
export interface Person { id: number; name: string }
@Component({
  selector: "app-c",
  standalone: true,
  template: \`<div>
  @if (open()) {
    <span>{{ open() }}</span>
  }
  @for (p of people(); track p.id) {
    <b>{{ p.name.toFixed(2) }}</b>
  }
</div>\`,
})
export class CComponent {
  open = input.required<boolean>();
  people = input.required<Person[]>();
}
`;
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(VIRTUAL, source);
    checker.dispose();

    // `name` is a string, so `.toFixed` does not exist on it.
    const ng = diagnostics.filter((d) => d.source === "ngtsc");
    expect(ng.length).toBeGreaterThanOrEqual(1);
    expect(ng.some((d) => d.message.includes("toFixed"))).toBe(true);
  });

  it("reports a missing track expression as a template parse error", () => {
    const source = `import { Component } from "@angular/core";
@Component({ selector: "app-p", standalone: true, template: \`@for (x of xs) { {{x}} }\` })
export class PComponent { xs = [1]; }
`;
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(VIRTUAL, source);
    checker.dispose();

    // Parse errors carry negative codes -- which is why a consumer must not
    // filter on a code range.
    expect(diagnostics.some((d) => d.code < 0)).toBe(true);
    expect(diagnostics.some((d) => d.message.includes("track"))).toBe(true);
  });

  it("reports an ordinary TypeScript error in the component's class body", () => {
    // `getNgSemanticDiagnostics` covers templates only, so this yields zero
    // Angular diagnostics. Reporting a clean list for a file that does not
    // compile would read as success, so the TS program's own diagnostics for
    // the entry file are collected too.
    const source = `import { Component } from "@angular/core";
@Component({ selector: "app-b", standalone: true, template: \`<b>ok</b>\` })
export class BComponent { bad: number = "str"; }
`;
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(VIRTUAL, source);
    checker.dispose();

    const tsDiagnostics = diagnostics.filter((d) => d.source === "ts");
    expect(tsDiagnostics.length).toBeGreaterThanOrEqual(1);
    // 2322: Type 'string' is not assignable to type 'number'.
    expect(tsDiagnostics.some((d) => d.code === 2322)).toBe(true);
    // And the template really is clean, so this is not a template diagnostic.
    expect(diagnostics.filter((d) => d.source === "ngtsc")).toEqual([]);
  });

  it("tags every diagnostic with a source", () => {
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    const diagnostics = checker.check(
      VIRTUAL,
      component("<span>{{ user.nmae }}</span>"),
    );
    checker.dispose();

    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    for (const d of diagnostics) {
      expect(["ts", "ngtsc"]).toContain(d.source);
    }
  });

  it("throws once disposed", () => {
    const checker = createAngularChecker({ projectDir: PROJECT_DIR });
    checker.dispose();

    expect(() => checker.check(VIRTUAL, component("<b>x</b>"))).toThrow(
      /disposed/,
    );
  });
});
