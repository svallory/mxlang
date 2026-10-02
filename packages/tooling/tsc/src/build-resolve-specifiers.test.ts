import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_ERROR,
  breakAll,
  CASE_TIMEOUT_MS,
  cliFixture,
  errorLines,
  importsOf,
  mxTscIn,
  privateNodeModules,
  scratch,
  solutionFixture,
  templateErrors,
} from "./build-uptodate-support.ts";

describe("mx-tsc -b resolves .mx modules like -p: specifiers that name a .ng.mx file", () => {
  // `-b` must resolve exactly as `-p` does: the solution builder hands tsc's
  // program a host that already resolves modules, and the Volar resolver must
  // still be the one answering for these specifiers.
  for (const specifier of [
    "./app.component.ng.mx",
    "./app.component.ng",
    "./app.component",
  ]) {
    it(
      `-b and -p agree on "${specifier}": it resolves, no TS2307`,
      async () => {
        const dir = scratch(cliFixture);
        breakAll(dir);
        importsOf(
          dir,
          `import { AppComponent } from "${specifier}";\nexport const c = AppComponent;\n`,
        );
        const project = await mxTscIn(dir, [
          "-p",
          "tsconfig.app.json",
          "--noEmit",
        ]);
        const listed = await mxTscIn(dir, [
          "-p",
          "tsconfig.app.json",
          "--listFilesOnly",
        ]);
        expect(listed.stdout).toContain("app.component.ng.mx");
        expect(project.output).not.toContain("TS2307");

        const build = await mxTscIn(dir, ["-b", "."]);
        expect(build.output).not.toContain("TS2307");
        expect(errorLines(build.output)).toEqual(errorLines(project.output));
        expect(templateErrors(build.output)).toEqual([APP_ERROR]);
      },
      CASE_TIMEOUT_MS,
    );
  }

  it(
    "-b reports, across a solution with references and paths, the diagnostics -p reports per project",
    async () => {
      const dir = scratch(solutionFixture);
      breakAll(dir);
      const build = await mxTscIn(dir, ["-b", "."]);
      const perProject = [
        ...new Set(
          (
            await Promise.all(
              ["app", "lib"].map((p) =>
                mxTscIn(dir, ["-p", p, "--noEmit"]).then((r) =>
                  errorLines(r.output),
                ),
              ),
            )
          ).flat(),
        ),
      ].sort();
      expect(build.output).not.toContain("TS2307");
      expect(errorLines(build.output)).toEqual(perProject);
    },
    CASE_TIMEOUT_MS,
  );

  // One specifier per file: a batch that also holds a `.mx`-suffixed literal
  // goes through Volar's resolver whole and would mask the bug.
  for (const specifier of [
    "../../lib/src/lib.component.ng",
    "../../lib/src/lib.component",
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

  // `x.d.ts` beside `x.ng.mx`: `-p` resolves the template (Volar's hidden
  // extensions), and `-b` must too, not the host's `.d.ts`.
  for (const [specifier, shadow] of [
    ["./app.component", "app.component.d.ts"],
    ["./app.component.ng", "app.component.ng.d.ts"],
  ] as const) {
    it(
      `"${specifier}" with ${shadow} beside the template: -b picks what -p picks`,
      async () => {
        const dir = scratch(cliFixture);
        writeFileSync(
          join(dir, "src", shadow),
          "export declare const AppComponent: string;\n",
        );
        importsOf(
          dir,
          `import { AppComponent } from "${specifier}";\nexport const s: string = AppComponent;\n`,
        );
        const project = await mxTscIn(dir, [
          "-p",
          "tsconfig.app.json",
          "--noEmit",
        ]);
        const build = await mxTscIn(dir, ["-b", "."]);
        // The template's class is not a string; the shadow's constant would be.
        expect(project.output).toContain("TS2322");
        expect(errorLines(build.output)).toEqual(errorLines(project.output));
      },
      CASE_TIMEOUT_MS,
    );
  }

  it(
    "a module that does not exist is still TS2307 under both -p and -b",
    async () => {
      const dir = scratch(cliFixture);
      importsOf(
        dir,
        `import { Nope } from "./nope";\nexport const c = Nope;\n`,
      );
      const project = await mxTscIn(dir, [
        "-p",
        "tsconfig.app.json",
        "--noEmit",
      ]);
      const build = await mxTscIn(dir, ["-b", "."]);
      expect(project.output).toContain("TS2307");
      expect(build.output).toContain("TS2307");
      expect(errorLines(build.output)).toEqual(errorLines(project.output));
    },
    CASE_TIMEOUT_MS,
  );
});
