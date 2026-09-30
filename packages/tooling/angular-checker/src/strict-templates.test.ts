import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker, TsconfigError } from "./index.ts";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const VIRTUAL = path.join(PROJECT_DIR, "x.component.ts");
const STRICT = path.join(PROJECT_DIR, "fixtures", "strict");

// Two template errors of different strictness:
// - `[label]="maybe"` binds `string | null` to a `string` input: reported only
//   in full (strictTemplates) mode (TS2322).
// - `{{ nope }}` is an unknown property of the component: reported in basic
//   mode too (TS2339).
const SOURCE = `import { Component, Input } from "@angular/core";
@Component({ selector: "kid", standalone: true, template: \`<p>{{ label }}</p>\` })
export class Kid { @Input() label: string = ""; }
@Component({ selector: "par", standalone: true, imports: [Kid], template: \`<kid [label]="maybe"></kid>{{ nope }}\` })
export class Par { maybe: string | null = null; }
`;

function ngtscCodes(tsconfig: string | undefined): number[] {
  const checker = createAngularChecker({
    projectDir: PROJECT_DIR,
    ...(tsconfig ? { tsconfigPath: path.join(STRICT, tsconfig) } : {}),
  });
  try {
    return checker
      .check(VIRTUAL, SOURCE)
      .filter((d) => d.source === "ngtsc")
      .map((d) => d.code)
      .sort();
  } finally {
    checker.dispose();
  }
}

describe("the project's strictTemplates is honoured, not forced", () => {
  it("strictTemplates: false reports the basic-mode error but not the strict-only one", () => {
    expect(ngtscCodes("off.json")).toEqual([2339]);
  });

  it("strictTemplates: true reports both", () => {
    expect(ngtscCodes("on.json")).toEqual([2322, 2339]);
  });

  it("strictTemplates unset follows compiler-cli's default, which is on", () => {
    // @angular/compiler-cli decides it in the TemplateTypeChecker config:
    //   get strictTemplates() { return this.options.strictTemplates !== false; }
    // ("strictTemplate is `true` by default. Explicit opt-out is required"):
    // node_modules/@angular/compiler-cli/bundles/chunk-M25TUZDV.js:4950-4951
    // in 22.1.7, chunk-HUSW2CW4.js:5032-5033 in 22.2.0.
    expect(ngtscCodes("unset.json")).toEqual([2322, 2339]);
  });

  it("with no tsconfig at all the same default applies", () => {
    expect(ngtscCodes(undefined)).toEqual([2322, 2339]);
  });
});

describe("TsconfigError for a missing tsconfig", () => {
  it("is one line: the path, then TypeScript's message", () => {
    const missing = path.join(STRICT, "missing.json");
    let caught: unknown;
    try {
      createAngularChecker({ projectDir: PROJECT_DIR, tsconfigPath: missing });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TsconfigError);
    const message = (caught as Error).message;
    expect(message).not.toContain("\n");
    // tsc's own wording for a -p path that does not exist (TS5058).
    expect(message).toBe(
      `${missing}: The specified path does not exist: '${missing}'.`,
    );
  });
});
