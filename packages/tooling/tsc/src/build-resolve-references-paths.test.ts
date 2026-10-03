import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CASE_TIMEOUT_MS,
  errorLines,
  mxTscIn,
  privateNodeModules,
  scratch,
  solutionFixture,
} from "./build-uptodate-support.ts";

describe("mx-tsc -b resolves .mx modules like -p: across project references", () => {
  // One specifier per file: a batch that also holds a `.mx`-suffixed literal
  // goes through Volar's resolver whole and would mask the bug.
  for (const specifier of [
    "@lib/lib.component.ng",
    "@lib/lib.component",
    "@scope/lib/cmp",
  ]) {
    it(
      `-b resolves "${specifier}" across a reference like -p`,
      async () => {
        const dir = scratch(solutionFixture);
        privateNodeModules(dir);
        const pkg = join(dir, "node_modules", "@scope", "lib");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
          join(pkg, "package.json"),
          '{ "name": "@scope/lib", "exports": { "./cmp": "./cmp.ng.mx" } }',
        );
        writeFileSync(
          join(pkg, "cmp.ng.mx"),
          'import { Component } from "@angular/core";\n\n@Component({ selector: "app-cmp", template: <p>x</p>, })\nexport class CmpComponent {}\n',
        );
        const appConfig = join(dir, "app", "tsconfig.json");
        const config = JSON.parse(readFileSync(appConfig, "utf8"));
        config.compilerOptions.paths = { "@lib/*": ["../lib/src/*"] };
        writeFileSync(appConfig, JSON.stringify(config));
        writeFileSync(
          join(dir, "app", "src", "main.ts"),
          `import * as m from "${specifier}";\nexport const x = m;\n`,
        );
        const build = await mxTscIn(dir, ["-b", "."]);
        expect(build.output).not.toContain("TS2307");
        // Both projects: `-b` also reports lib's own (pre-existing) TS6307.
        const perProject = new Set<string>();
        for (const project of ["app", "lib"]) {
          const run = await mxTscIn(dir, ["-p", project, "--noEmit"]);
          for (const line of errorLines(run.output)) perProject.add(line);
        }
        expect(errorLines(build.output)).toEqual([...perProject].sort());
      },
      CASE_TIMEOUT_MS,
    );
  }
});
