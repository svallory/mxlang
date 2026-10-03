import { describe, expect, it } from "vitest";
import {
  APP_ERROR,
  breakAll,
  CASE_TIMEOUT_MS,
  cliFixture,
  errorLines,
  importsOf,
  mxTscIn,
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
});
