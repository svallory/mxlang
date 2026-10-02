import { mkdirSync, writeFileSync } from "node:fs";
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

  // A package's own `.d.ts` beside its `.ng.mx` is NOT overruled: what a package
  // publishes as its types wins under `-b` (and `-w`), while `-p` alone resolves
  // the template. Pinned so a change of that rule is deliberate.
  it(
    "a package .d.ts beside its .ng.mx keeps the host's answer (the .d.ts) under -b",
    async () => {
      const dir = scratch(cliFixture);
      privateNodeModules(dir);
      const pkg = join(dir, "node_modules", "shadowpkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        '{ "name": "shadowpkg", "exports": { "./cmp": { "types": "./cmp.d.ts" } } }',
      );
      writeFileSync(
        join(pkg, "cmp.d.ts"),
        "export declare const AppComponent: string;\n",
      );
      writeFileSync(
        join(pkg, "cmp.ng.mx"),
        'import { Component } from "@angular/core";\n\n@Component({ selector: "app-cmp", template: <p>x</p>, })\nexport class AppComponent {}\n',
      );
      importsOf(
        dir,
        'import { AppComponent } from "shadowpkg/cmp";\nexport const s: string = AppComponent;\n',
      );
      const build = await mxTscIn(dir, ["-b", "."]);
      expect(build.output).not.toContain("TS2322");
      expect(build.output).not.toContain("TS2307");
    },
    CASE_TIMEOUT_MS,
  );

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
