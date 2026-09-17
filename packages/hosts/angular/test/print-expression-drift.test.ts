import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { compileNgMx } from "../src/ng-mx.ts";

/**
 * `src/ng-mx.ts` keeps a private `printExpression` — a copy of the helper
 * `packages/core` uses on its whole-file path and does not export. The
 * region path cannot reach core's, so the copy stands until core exports
 * one (a follow-up filed with the tag-unit squad, who own that package).
 *
 * A copy can drift. These assert the two paths print the *same* expression
 * identically, so a change to core's generator options that this copy does
 * not mirror fails here rather than showing up as a subtly different
 * emitted template.
 */
describe("printExpression parity with core's whole-file path", () => {
  const EXPRESSIONS = [
    // A member chain, an optional call, and a conditional with an object
    // literal: between them these cover the generator settings most likely
    // to drift (spacing, parens, and `concise`).
    "user.profile.name",
    "items.filter((i) => i.active).length",
    "flag ? { a: 1, b: 2 } : fallback(x, y)",
  ];

  for (const expression of EXPRESSIONS) {
    it(`prints \`${expression}\` the same on both paths`, () => {
      // The page path, through core's own `compileSource`.
      const page = compile(`<div>\${${expression}}</div>`, "/p/x.mx");
      // The region path, through this package's copy.
      const region = compileNgMx(
        [
          'import { Component } from "@angular/core";',
          "@Component({",
          '  selector: "app-x",',
          `  template: <div>\${${expression}}</div>,`,
          "})",
          "export class XComponent {}",
        ].join("\n"),
        "/p/x.component.ng.mx",
      );

      const fromRegion = region.code.match(/template: `([\s\S]*?)`,/)?.[1];
      expect(fromRegion).toBe(page.code);
    });
  }
});
