import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildProjects } from "./build-templates.ts";
import {
  APP_ERROR,
  BROKEN,
  breakAll,
  CASE_TIMEOUT_MS,
  CLEAN,
  cliFixture,
  expectCheckedSetIsListedSet,
  importsOf,
  LIB_ERROR,
  mxTscIn,
  type Run,
  refsFixture,
  SPAWN,
  scratch,
  setBody,
  setTemplate,
  solutionFixture,
  templateErrors,
  unlinkProjects,
} from "./build-uptodate-support.ts";

describe("mx-tsc -b: Angular templates of up-to-date projects", () => {
  it(
    "checks an up-to-date project and a rebuilt one in the same run, each error once",
    async () => {
      const dir = scratch(refsFixture);
      unlinkProjects(dir);
      setTemplate(dir, "lib", BROKEN);
      setTemplate(dir, "app", BROKEN);
      const roots = [join(dir, "lib"), join(dir, "app")];
      expect((await mxTscIn(dir, ["-b", ...roots])).status).toBe(1);

      // lib gets a new TypeScript file: tsc rebuilds lib and leaves app
      // untouched, so app is the up-to-date one.
      writeFileSync(
        join(dir, "lib", "src", "extra.ts"),
        "export const x = 1;\n",
      );
      const mixed = await mxTscIn(dir, ["-b", "-v", ...roots]);
      expect(mixed.stdout).toMatch(
        /Project '.*app\/tsconfig\.json' is up to date/,
      );
      expect(mixed.stdout).not.toMatch(
        /Project '.*lib\/tsconfig\.json' is up to date/,
      );
      expect(mixed.status).toBe(1);
      expect(templateErrors(mixed.output).sort()).toEqual([
        APP_ERROR,
        LIB_ERROR,
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "--dry, --help and a rejected -b command line check nothing; --clean checks nothing and exits 0 even with a broken template",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);

      for (const flag of ["--dry", "-d"]) {
        const dry = await mxTscIn(app, ["-b", flag, "."]);
        expect(dry.status).toBe(0);
        expect(templateErrors(dry.output)).toEqual([]);
        expect(dry.stdout).toMatch(
          /--dry skips Angular template diagnostics; a build would check the \.ng\.mx files of '.*app\/tsconfig\.json'/,
        );
        // lib too: a dry run names every project of the graph.
        expect(dry.stdout).toMatch(
          /would check the \.ng\.mx files of '.*lib\/tsconfig\.json'/,
        );
        expect(existsSync(join(app, "out"))).toBe(false);
      }

      const help = await mxTscIn(app, ["-b", "--help"], SPAWN);
      expect(help.status).toBe(0);
      expect(templateErrors(help.output)).toEqual([]);
      // tsc itself rejects `--version` under `-b` (TS5094) and exits 1.
      const version = await mxTscIn(app, ["-b", "--version"], SPAWN);
      expect(version.output).toContain("TS5094");
      expect(templateErrors(version.output)).toEqual([]);

      expect((await mxTscIn(app, ["-b", "."])).status).toBe(1);
      const clean = await mxTscIn(app, ["-b", "--clean", "."]);
      expect(clean.output).toBe("");
      expect(clean.status).toBe(0);
      expect(existsSync(join(app, "out", "tsconfig.tsbuildinfo"))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "checks a .ng.mx reached only by import (the Angular CLI solution layout), through a paths alias and a barrel importing it twice, on every run; fix passes; reintroduced fails",
    async () => {
      const dir = scratch(cliFixture);
      const file = join(dir, "src", "app.component.ng.mx");
      setBody(file, BROKEN);
      mkdirSync(join(dir, "src", "deep"));
      writeFileSync(
        join(dir, "src", "deep", "barrel.ts"),
        'export { AppComponent } from "../app.component.ng.mx";\nexport { AppComponent as Again } from "../app.component.ng.mx";\n',
      );
      importsOf(
        dir,
        'import { AppComponent } from "@app/app.component.ng.mx";\nimport "@app/deep/barrel";\nexport const c = AppComponent;\n',
      );
      const config = join(dir, "tsconfig.app.json");
      const json = JSON.parse(readFileSync(config, "utf8"));
      json.compilerOptions.paths = { "@app/*": ["./src/*"] };
      writeFileSync(config, JSON.stringify(json));

      const first = await mxTscIn(dir, ["-b", "."]);
      expect(first.status).toBe(1);
      expect(templateErrors(first.output)).toEqual([APP_ERROR]);
      // tsc's build info says the project is up to date; the file is in no
      // `include`, only in `main.ts`'s imports.
      const second = await mxTscIn(dir, ["-b", "."]);
      expect(second.status).toBe(1);
      expect(second.output).toBe(first.output);
      await expectCheckedSetIsListedSet(second.output, [
        { cwd: dir, config: join(dir, "tsconfig.app.json") },
      ]);

      setBody(file, CLEAN);
      const fixed = await mxTscIn(dir, ["-b", "."]);
      expect(fixed.output).toBe("");
      expect(fixed.status).toBe(0);
      setBody(file, BROKEN);
      const again = await mxTscIn(dir, ["-b", "."]);
      expect(again.status).toBe(1);
      expect(templateErrors(again.output)).toEqual([APP_ERROR]);
    },
    CASE_TIMEOUT_MS,
  );

  describe("extensionless .ng.mx specifiers (known gap)", () => {
    // Known gap, TODO mx-tsc-build-extensionless-resolve: `mx-tsc -p` resolves
    // `./x` and `./x.ng` to `x.ng.mx`, but under `-b` tsc reports TS2307. Not
    // silent (exit 1 on every run, the project can never be up to date), only
    // wrong. Pinned so a fix to the `-b` resolution has to update this test.
    for (const specifier of ["./app.component.ng", "./app.component"]) {
      it(
        `-p resolves "${specifier}" (and -b reports TS2307 for it: known gap)`,
        async () => {
          const dir = scratch(cliFixture);
          breakAll(dir);
          importsOf(
            dir,
            `import { AppComponent } from "${specifier}";\nexport const c = AppComponent;\n`,
          );
          const listed = await mxTscIn(dir, [
            "-p",
            "tsconfig.app.json",
            "--listFilesOnly",
          ]);
          expect(listed.stdout).toContain("app.component.ng.mx");
          expect(listed.output).not.toContain("TS2307");

          // One `-b` is enough (they fail alike); the other specifier is pinned
          // by `-p` resolving it.
          if (specifier === "./app.component.ng") {
            const build = await mxTscIn(dir, ["-b", "."]);
            expect(build.status).toBe(1);
            expect(build.output).toContain("TS2307");
          }
        },
        CASE_TIMEOUT_MS,
      );
    }
  });

  it(
    "checks a referenced project's .ng.mx under that project's own tsconfig (its paths), not the referencing one's, on both runs",
    async () => {
      const dir = scratch(solutionFixture);
      expect(breakAll(dir)).toHaveLength(1);
      let last: Run | undefined;
      for (const run of [1, 2]) {
        last = await mxTscIn(dir, ["-b", "."]);
        expect(last.status, `run ${run}`).toBe(1);
        expect(templateErrors(last.output), `run ${run}`).toEqual([
          "lib.component.ng.mx(6,18): TS2339",
        ]);
      }
      await expectCheckedSetIsListedSet((last as Run).output, [
        { cwd: join(dir, "app"), config: join(dir, "app", "tsconfig.json") },
        { cwd: join(dir, "lib"), config: join(dir, "lib", "tsconfig.json") },
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it("lists projects dependencies first and marks a solution root, which selects no root files, as having none", () => {
    const projects = resolveBuildProjects(["-b", "."], solutionFixture);
    expect(
      projects.map((p) => [basename(dirname(p.tsconfigPath)), p.hasFiles]),
    ).toEqual([
      ["lib", true],
      ["app", true],
      ["ng-build-solution", false],
    ]);
  });
});
