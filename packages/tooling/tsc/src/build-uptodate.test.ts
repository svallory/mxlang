import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `tsc -b` skips a project its build info calls up to date, and tsc's
 * incremental state knows nothing about Angular templates. These tests pin the
 * ruling that the template pass runs for every project of the build graph
 * regardless: the second, no-change run must fail exactly as the first did.
 *
 * Each test works on a copy of `fixtures/ng-build-refs` under the OS temp dir
 * (so `-b` leaves no `out/` or `.tsbuildinfo` in the repo, and a test can edit
 * a template between runs), with the package's own `node_modules` linked in so
 * `@angular/compiler-cli` and `@angular/core` resolve.
 */

const SPAWN_TIMEOUT_MS = 120_000;
const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const mxTsc = join(packageDir, "dist", "bin.cjs");
const fixture = join(here, "fixtures", "ng-build-refs");
/** Angular CLI's default layout: a solution root, a non-composite app project. */
const cliFixture = join(here, "fixtures", "ng-build-cli");

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

function mxTscIn(cwd: string, args: string[]): Run {
  const result = spawnSync(process.execPath, [mxTsc, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

/** The `.ng.mx` diagnostics (`file(line,col): error TSnnnn`) in `output`, basename only. */
function templateErrors(output: string): string[] {
  return [
    ...output.matchAll(/([\w.-]+\.ng\.mx)\((\d+),(\d+)\): error (TS\d+)/g),
  ].map((m) => `${m[1]}(${m[2]},${m[3]}): ${m[4]}`);
}

describe("mx-tsc -b: Angular templates of up-to-date projects", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      if (dir.length > 1) rmSync(dir, { recursive: true, force: true });
    }
    // Every spawn blocks this worker's thread; past a minute of that vitest's
    // own worker RPC times out (`Timeout calling "onTaskUpdate"`), so each test
    // hands the event loop back.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  function scratch(from = fixture): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-tsc-build-")));
    created.push(dir);
    cpSync(from, dir, { recursive: true });
    symlinkSync(join(packageDir, "node_modules"), join(dir, "node_modules"));
    return dir;
  }

  const template = (dir: string, project: "lib" | "app") =>
    join(dir, project, "src", `${project}.component.ng.mx`);

  function setTemplate(dir: string, project: "lib" | "app", body: string) {
    const file = template(dir, project);
    const source = readFileSync(file, "utf8").replace(
      /template: .*,\n/,
      `template: ${body},\n`,
    );
    writeFileSync(file, source);
  }

  /** The two projects as independent roots: no `references` between them. */
  function unlinkProjects(dir: string) {
    const file = join(dir, "app", "tsconfig.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    delete config.references;
    writeFileSync(file, JSON.stringify(config));
  }

  it(
    "fails the second, up-to-date run exactly as the first; fixing the template passes; breaking it again fails",
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);

      const first = mxTscIn(app, ["-b", "."]);
      expect(first.status).toBe(1);
      expect(templateErrors(first.output)).toEqual([
        "app.component.ng.mx(5,18): TS2339",
      ]);
      expect(first.output).toContain("nmae");

      // tsc's build info now says everything is up to date.
      expect(existsSync(join(app, "out", "tsconfig.tsbuildinfo"))).toBe(true);
      const second = mxTscIn(app, ["-b", "."]);
      expect(second.status).toBe(1);
      expect(second.output).toBe(first.output);

      setTemplate(dir, "app", CLEAN);
      const fixed = mxTscIn(app, ["-b", "."]);
      expect(fixed.output).toBe("");
      expect(fixed.status).toBe(0);
      // Nothing changed since: up to date, and still clean.
      expect(mxTscIn(app, ["-b", "."]).status).toBe(0);

      setTemplate(dir, "app", BROKEN);
      const again = mxTscIn(app, ["-b", "."]);
      expect(again.status).toBe(1);
      expect(templateErrors(again.output)).toEqual([
        "app.component.ng.mx(5,18): TS2339",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a template error with the file:line:col a non-build run reports",
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);
      const plain = mxTscIn(app, ["--noEmit", "-p", "."]);
      expect(plain.status).not.toBe(0);

      mxTscIn(app, ["-b", "."]);
      const upToDate = mxTscIn(app, ["-b", "."]);
      expect(templateErrors(upToDate.output)).toEqual(
        templateErrors(plain.output),
      );
      expect(templateErrors(upToDate.output)).toEqual([
        "app.component.ng.mx(5,18): TS2339",
      ]);
      // The full line, message included, is what a non-build run prints.
      const line = (output: string) =>
        output.split("\n").find((l) => l.includes("error TS2339"));
      expect(line(upToDate.output)).toBe(line(plain.output));
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "checks every project of a reference graph, each error once, rebuilt or not",
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      setTemplate(dir, "lib", BROKEN);
      setTemplate(dir, "app", BROKEN);

      const first = mxTscIn(app, ["-b", "."]);
      expect(first.status).toBe(1);
      const expected = [
        "app.component.ng.mx(5,18): TS2339",
        "lib.component.ng.mx(5,18): TS2339",
      ];
      // `.sort()`: the order across projects is not part of the contract.
      expect(templateErrors(first.output).sort()).toEqual(expected);

      const second = mxTscIn(app, ["-b", "."]);
      expect(second.status).toBe(1);
      expect(templateErrors(second.output).sort()).toEqual(expected);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports the referenced project's template even when only the root is named and the root is clean",
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      setTemplate(dir, "lib", BROKEN);
      expect(mxTscIn(app, ["-b", "."]).status).toBe(1);
      const second = mxTscIn(app, ["-b", "."]);
      expect(second.status).toBe(1);
      expect(templateErrors(second.output)).toEqual([
        "lib.component.ng.mx(5,18): TS2339",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "checks an up-to-date project and a rebuilt one in the same run, each error once",
    () => {
      const dir = scratch();
      unlinkProjects(dir);
      setTemplate(dir, "lib", BROKEN);
      setTemplate(dir, "app", BROKEN);
      const roots = [join(dir, "lib"), join(dir, "app")];
      expect(mxTscIn(dir, ["-b", ...roots]).status).toBe(1);

      // lib gets a new TypeScript file: tsc rebuilds lib and leaves app
      // untouched, so app is the up-to-date one.
      writeFileSync(
        join(dir, "lib", "src", "extra.ts"),
        "export const x = 1;\n",
      );
      const mixed = mxTscIn(dir, ["-b", "-v", ...roots]);
      expect(mixed.stdout).toMatch(
        /Project '.*app\/tsconfig\.json' is up to date/,
      );
      expect(mixed.stdout).not.toMatch(
        /Project '.*lib\/tsconfig\.json' is up to date/,
      );
      expect(mixed.status).toBe(1);
      expect(templateErrors(mixed.output).sort()).toEqual([
        "app.component.ng.mx(5,18): TS2339",
        "lib.component.ng.mx(5,18): TS2339",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "does not report a rebuilt project's template twice, and --force reports it once",
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);
      for (const args of [
        ["-b", "."],
        ["-b", "--force", "."],
        ["-b", "--force", "."],
      ]) {
        const result = mxTscIn(app, args);
        expect(result.status).toBe(1);
        expect(
          templateErrors(result.output).filter((e) => e.startsWith("app.")),
        ).toEqual(["app.component.ng.mx(5,18): TS2339"]);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'honors mx.angular.diagnostics "off" for an up-to-date project',
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);
      expect(mxTscIn(app, ["-b", "."]).status).toBe(1);
      writeFileSync(
        join(app, "package.json"),
        JSON.stringify({
          name: "ng-build-app",
          mx: { angular: { diagnostics: "off" } },
        }),
      );
      const second = mxTscIn(app, ["-b", "."]);
      expect(second.output).toBe("");
      expect(second.status).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "--clean checks no template and exits 0, even with a broken one",
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);
      expect(mxTscIn(app, ["-b", "."]).status).toBe(1);
      const clean = mxTscIn(app, ["-b", "--clean", "."]);
      expect(clean.output).toBe("");
      expect(clean.status).toBe(0);
      expect(existsSync(join(app, "out", "tsconfig.tsbuildinfo"))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "--dry builds and checks nothing, and says a build would check the templates instead of passing as ok",
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      setTemplate(dir, "app", BROKEN);
      for (const flag of ["--dry", "-d"]) {
        const dry = mxTscIn(app, ["-b", flag, "."]);
        expect(dry.status).toBe(0);
        expect(templateErrors(dry.output)).toEqual([]);
        expect(dry.stdout).toMatch(
          /--dry skips Angular template diagnostics; a build would check 1 \.ng\.mx file of '.*app\/tsconfig\.json'/,
        );
        // lib too: a dry run names every project of the graph.
        expect(dry.stdout).toMatch(
          /would check 1 \.ng\.mx file of '.*lib\/tsconfig\.json'/,
        );
        expect(existsSync(join(app, "out"))).toBe(false);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "fails with a message, not silence, when an up-to-date project's .ng.mx no longer compiles",
    () => {
      const dir = scratch();
      const app = join(dir, "app");
      expect(mxTscIn(app, ["-b", "."]).status).toBe(0);
      // Breaking the template's own markup: the compile itself fails, and
      // that is reported by the language plugin, once, not by the template pass.
      writeFileSync(
        template(dir, "app"),
        readFileSync(template(dir, "app"), "utf8").replace("<p>", "<p"),
      );
      const result = mxTscIn(app, ["-b", "."]);
      expect(result.status).toBe(1);
      expect(result.output).toContain("app.component.ng.mx(");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "checks a .ng.mx reached only by import (the Angular CLI solution layout) on every run",
    () => {
      const dir = scratch(cliFixture);
      const file = join(dir, "src", "app.component.ng.mx");
      const broken = (body: string) =>
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace(
            /template: .*,\n/,
            `template: ${body},\n`,
          ),
        );
      broken(BROKEN);

      const first = mxTscIn(dir, ["-b", "."]);
      expect(first.status).toBe(1);
      expect(templateErrors(first.output)).toEqual([
        "app.component.ng.mx(5,18): TS2339",
      ]);
      // tsc's build info says the project is up to date; the file is in
      // no `include`, only in `main.ts`'s import closure.
      const second = mxTscIn(dir, ["-b", "."]);
      expect(second.status).toBe(1);
      expect(second.output).toBe(first.output);

      broken(CLEAN);
      expect(mxTscIn(dir, ["-b", "."]).status).toBe(0);
      expect(mxTscIn(dir, ["-b", "."]).status).toBe(0);
      broken(BROKEN);
      expect(mxTscIn(dir, ["-b", "."]).status).toBe(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "follows imports through .ts files and a paths alias, and checks each file once",
    () => {
      const dir = scratch(cliFixture);
      const file = join(dir, "src", "app.component.ng.mx");
      writeFileSync(file, readFileSync(file, "utf8").replace(CLEAN, BROKEN));
      mkdirSync(join(dir, "src", "deep"));
      writeFileSync(join(dir, "src", "main.ts"), 'import "@app/barrel";\n');
      writeFileSync(
        join(dir, "src", "deep", "barrel.ts"),
        'export { AppComponent } from "../app.component.ng.mx";\nexport { AppComponent as Again } from "../app.component.ng.mx";\n',
      );
      const config = join(dir, "tsconfig.app.json");
      const json = JSON.parse(readFileSync(config, "utf8"));
      json.compilerOptions.paths = { "@app/*": ["./src/deep/*"] };
      writeFileSync(config, JSON.stringify(json));

      for (const expectedRun of [1, 2]) {
        const result = mxTscIn(dir, ["-b", "."]);
        expect(result.status, `run ${expectedRun}`).toBe(1);
        expect(templateErrors(result.output)).toEqual([
          "app.component.ng.mx(5,18): TS2339",
        ]);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "never runs the template pass for -b --help, nor for a -b command line tsc rejects",
    () => {
      const dir = scratch();
      setTemplate(dir, "app", BROKEN);
      const app = join(dir, "app");
      const help = mxTscIn(app, ["-b", "--help"]);
      expect(help.status).toBe(0);
      expect(templateErrors(help.output)).toEqual([]);
      // tsc itself rejects `--version` under `-b` (TS5094) and exits 1.
      const version = mxTscIn(app, ["-b", "--version"]);
      expect(version.output).toContain("TS5094");
      expect(templateErrors(version.output)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );
});
