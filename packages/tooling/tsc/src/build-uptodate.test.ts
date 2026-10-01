import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildProjects } from "./build-templates.ts";

/**
 * `tsc -b` skips a project its build info calls up to date, and tsc's
 * incremental state knows nothing about Angular templates. These tests pin the
 * ruling that the template pass runs for every project of the build graph
 * regardless: the second, no-change run must fail exactly as the first did.
 *
 * Each case works on its own copy of a `fixtures/ng-build-*` project under the
 * OS temp dir (so `-b` leaves no `out/` or `.tsbuildinfo` in the repo, and a
 * case can edit a template between runs), with the package's own
 * `node_modules` linked in so `@angular/compiler-cli` and `@angular/core`
 * resolve.
 *
 * Runtime: every run is an async child process (a synchronous spawn blocks the
 * vitest worker, and past a minute of that its RPC to the runner times out:
 * `Timeout calling "onTaskUpdate"`). Cases are independent, so they run
 * concurrently, behind a gate that caps live `mx-tsc` processes. Each case
 * spends its runs on one scenario (build, rebuild, edit, rebuild ...) instead
 * of rebuilding a fresh copy per assertion.
 */

const CASE_TIMEOUT_MS = 300_000;
/** Live `mx-tsc` processes at once: 2 locally (not a CPU burner), more on CI. */
const MAX_PROCESSES = process.env.CI ? 4 : 2;
const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const mxTsc = join(packageDir, "dist", "bin.cjs");
const fixtures = join(here, "fixtures");
const refsFixture = join(fixtures, "ng-build-refs");
/** Angular CLI's default layout: a solution root, a non-composite app project. */
const cliFixture = join(fixtures, "ng-build-cli");
const solutionFixture = join(fixtures, "ng-build-solution");

// biome-ignore lint/suspicious/noTemplateCurlyInString: MX interpolation, not a JS template
const CLEAN = "<p>${user.name}</p>";
// biome-ignore lint/suspicious/noTemplateCurlyInString: MX interpolation, not a JS template
const BROKEN = "<p>${user.nmae}</p>";

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  output: string;
}

let live = 0;
const waiting: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (live < MAX_PROCESSES) {
    live++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else live--;
}

async function mxTscIn(cwd: string, args: string[]): Promise<Run> {
  await acquire();
  try {
    return await new Promise<Run>((resolve) => {
      execFile(
        process.execPath,
        [mxTsc, ...args],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: "1" },
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          resolve({
            status: error ? (typeof code === "number" ? code : 1) : 0,
            stdout,
            stderr,
            output: `${stdout}${stderr}`,
          });
        },
      );
    });
  } finally {
    release();
  }
}

/** The `.ng.mx` diagnostics (`file(line,col): error TSnnnn`) in `output`, basename only. */
function templateErrors(output: string): string[] {
  return [
    ...output.matchAll(/([\w.-]+\.ng\.mx)\((\d+),(\d+)\): error (TS\d+)/g),
  ].map((m) => `${m[1]}(${m[2]},${m[3]}): ${m[4]}`);
}

const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) {
    if (dir.length > 1) rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(from: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-tsc-build-")));
  created.push(dir);
  cpSync(from, dir, { recursive: true });
  symlinkSync(join(packageDir, "node_modules"), join(dir, "node_modules"));
  return dir;
}

type Project = "lib" | "app";
const template = (dir: string, project: Project) =>
  join(dir, project, "src", `${project}.component.ng.mx`);

function setBody(file: string, body: string) {
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      /template: .*,\n/,
      `template: ${body},\n`,
    ),
  );
}

const setTemplate = (dir: string, project: Project, body: string) =>
  setBody(template(dir, project), body);

/** Break the template of every `.ng.mx` under `dir` (not node_modules, not outputs). */
function breakAll(dir: string): string[] {
  const broken: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "out") visit(full);
      } else if (entry.name.endsWith(".ng.mx")) {
        setBody(full, BROKEN);
        broken.push(full);
      }
    }
  };
  visit(dir);
  return broken;
}

/** The two projects as independent roots: no `references` between them. */
function unlinkProjects(dir: string) {
  const file = join(dir, "app", "tsconfig.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  delete config.references;
  writeFileSync(file, JSON.stringify(config));
}

const importsOf = (dir: string, body: string) =>
  writeFileSync(join(dir, "src", "main.ts"), body);

/**
 * The oracle: the `.ng.mx` basenames `mx-tsc -p <config> --listFilesOnly` lists
 * for each of `configs` (what tsc compiles for those projects), versus the files
 * the `-b` run reported (every template in the fixture is broken).
 */
async function expectCheckedSetIsListedSet(
  output: string,
  configs: { cwd: string; config: string }[],
) {
  const listed = new Set<string>();
  for (const { cwd, config } of configs) {
    const out = await mxTscIn(cwd, ["-p", config, "--listFilesOnly"]);
    for (const line of out.stdout.split("\n")) {
      if (line.endsWith(".ng.mx")) listed.add(basename(line));
    }
  }
  expect(listed.size).toBeGreaterThan(0);
  const checked = new Set(templateErrors(output).map((e) => e.split("(")[0]));
  expect(checked).toEqual(listed);
}

const APP_ERROR = "app.component.ng.mx(5,18): TS2339";
const LIB_ERROR = "lib.component.ng.mx(5,18): TS2339";

describe.concurrent("mx-tsc -b: Angular templates of up-to-date projects", () => {
  it(
    "fails the up-to-date run exactly as the first, at tsc's own position and message; a markup break is reported",
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);

      const first = await mxTscIn(app, ["-b", "."]);
      expect(first.status).toBe(1);
      // Exact position, and tsc's own message (the one a non-build run prints).
      expect(templateErrors(first.output)).toEqual([APP_ERROR]);
      expect(first.output).toContain(
        "error TS2339: Property 'nmae' does not exist on type '{ name: string; }'.",
      );

      // tsc's build info now says everything is up to date.
      expect(existsSync(join(app, "out", "tsconfig.tsbuildinfo"))).toBe(true);
      const second = await mxTscIn(app, ["-b", "."]);
      expect(second.status).toBe(1);
      expect(second.output).toBe(first.output);

      // Breaking the template's own markup: the compile itself fails, and that
      // is reported by the language plugin, once, not by the template pass.
      writeFileSync(
        template(dir, "app"),
        readFileSync(template(dir, "app"), "utf8").replace("<p>", "<p"),
      );
      const markup = await mxTscIn(app, ["-b", "."]);
      expect(markup.status).toBe(1);
      expect(markup.output).toContain("app.component.ng.mx(");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'checks every project of a reference graph, each error once, whether rebuilt or not; honors "off" per project',
    async () => {
      const dir = scratch(refsFixture);
      const app = join(dir, "app");
      setTemplate(dir, "lib", BROKEN);
      setTemplate(dir, "app", BROKEN);
      // `.sort()`: the order across projects is not part of the contract.
      const both = [APP_ERROR, LIB_ERROR];

      const first = await mxTscIn(app, ["-b", "."]);
      expect(first.status).toBe(1);
      expect(templateErrors(first.output).sort()).toEqual(both);
      const second = await mxTscIn(app, ["-b", "."]);
      expect(second.status).toBe(1);
      expect(templateErrors(second.output).sort()).toEqual(both);
      await expectCheckedSetIsListedSet(second.output, [
        { cwd: app, config: join(app, "tsconfig.json") },
        { cwd: join(dir, "lib"), config: join(dir, "lib", "tsconfig.json") },
      ]);

      // app turns its diagnostics off: it is skipped even though up to date;
      // lib's error stays.
      writeFileSync(
        join(app, "package.json"),
        JSON.stringify({
          name: "ng-build-app",
          mx: { angular: { diagnostics: "off" } },
        }),
      );
      const third = await mxTscIn(app, ["-b", "."]);
      expect(third.status).toBe(1);
      expect(templateErrors(third.output)).toEqual([LIB_ERROR]);
    },
    CASE_TIMEOUT_MS,
  );

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

      const help = await mxTscIn(app, ["-b", "--help"]);
      expect(help.status).toBe(0);
      expect(templateErrors(help.output)).toEqual([]);
      // tsc itself rejects `--version` under `-b` (TS5094) and exits 1.
      const version = await mxTscIn(app, ["-b", "--version"]);
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

  describe.concurrent("extensionless .ng.mx specifiers (known gap)", () => {
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
