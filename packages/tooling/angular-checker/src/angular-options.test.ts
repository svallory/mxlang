import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAngularChecker } from "./index.ts";

const PROJECT_DIR = path.resolve(import.meta.dirname, "..");
const VIRTUAL = path.join(PROJECT_DIR, "x.component.ts");
const AC = path.join(PROJECT_DIR, "fixtures", "ac");

// Passing `string | null` to a `string` input is an error only while
// `angularCompilerOptions.strictNullInputTypes` is on (it is under
// strictTemplates), so that one option shows whether a tsconfig's
// angularCompilerOptions reached the checker.
const SOURCE = `import { Component, Input } from "@angular/core";
@Component({ selector: "kid", standalone: true, template: \`<p>{{ label }}</p>\` })
export class Kid { @Input() label: string = ""; }
@Component({ selector: "par", standalone: true, imports: [Kid], template: \`<kid [label]="maybe"></kid>\` })
export class Par { maybe: string | null = null; }
`;

function ngtscCodes(tsconfig: string | undefined): number[] {
  const checker = createAngularChecker({
    projectDir: PROJECT_DIR,
    ...(tsconfig ? { tsconfigPath: path.join(AC, tsconfig) } : {}),
  });
  try {
    return checker
      .check(VIRTUAL, SOURCE)
      .filter((d) => d.source === "ngtsc")
      .map((d) => d.code);
  } finally {
    checker.dispose();
  }
}

describe("angularCompilerOptions through the tsconfig extends chain", () => {
  it("baseline: without any config the null input is an error", () => {
    expect(ngtscCodes(undefined)).toEqual([2322]);
  });

  it("reads a leaf tsconfig's own angularCompilerOptions", () => {
    expect(ngtscCodes("direct.json")).toEqual([]);
  });

  it("reads angularCompilerOptions from the base of an `extends` (the Angular CLI layout)", () => {
    // tsconfig.json holds angularCompilerOptions; tsconfig.app.json extends it.
    expect(ngtscCodes("tsconfig.app.json")).toEqual([]);
  });

  it("reads them through a two-level extends chain", () => {
    expect(ngtscCodes("leaf2.json")).toEqual([]);
  });

  it("lets a leaf override a base angularCompilerOptions value", () => {
    expect(ngtscCodes("override.json")).toEqual([2322]);
  });
});
